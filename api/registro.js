// Captura de registros de la landing de Mining Big.
//
// Reemplaza al workflow de n8n "Mining Big — Captura de registros"
// (OYd1k8lm0Sd5oHfc), que se cayó cuando venció la prueba gratuita.
// Misma entrada y misma salida que el webhook viejo, así que la landing
// solo cambia la URL: el body sigue siendo {nombre, empresa, email,
// telefono, zona, plazo, equipo[], detalle} y la respuesta {ok, folio}.

const { Pool } = require('pg');
const crypto = require('crypto');
const { CA_SUPABASE } = require('../lib/supabase-ca');

// La integración oficial de Supabase con Vercel inyecta `POSTGRES_URL` sola,
// sin que nadie copie a mano una cadena que lleva la contraseña dentro.
// `DATABASE_URL` se sigue aceptando, y tiene prioridad, para el caso de
// ponerla a mano o de mudarse a otro Postgres.
function cadenaConexion() {
  const cruda = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!cruda) return '';
  // Se quita `sslmode` de la cadena: `pg` deja que lo de la URL pise la
  // configuración explícita, y con él puesto se ignora el `ssl: { ca }` de
  // abajo. El TLS se decide en un solo sitio. Ver `api/crm.js`.
  try {
    const u = new URL(cruda);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch (e) {
    return cruda;
  }
}

// El pool vive fuera del handler a propósito: Vercel reutiliza el proceso
// entre invocaciones y así no se abre una conexión por request.
let pool;
function obtenerPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: cadenaConexion(),
      // Verificar contra la CA de Supabase, no contra el almacén de Node.
      ssl: { ca: CA_SUPABASE },
      max: 1, // una función serverless atiende un request a la vez
      idleTimeoutMillis: 10000,
      // Por debajo del limite por defecto de la funcion (10 s en Vercel): con
      // 8 s, un arranque en frio con la base tambien fria se comia casi todo
      // el presupuesto y la plataforma cortaba con un 504 sin JSON, que la
      // landing muestra como error generico. Ver `api/crm.js`.
      connectionTimeoutMillis: 5000,
      query_timeout: 6000,
    });
    // Sin este listener, un error en una conexión ociosa (el Postgres la
    // cierra, se cae la red) llega como 'error' sin manejar y Node tumba
    // el proceso entero: se pierden los registros que estuvieran en vuelo.
    // Con el listener, la conexión rota se descarta y el pool abre otra.
    // pg ya descarta la conexión rota y abre otra sola; lo único que hace
    // falta es que el evento tenga oyente.
    pool.on('error', (err) => {
      console.error('Conexión ociosa del pool caída:', err.message);
    });
  }
  return pool;
}

// Fecha en hora de Perú, no en UTC. El servidor corre en UTC y sin esto
// los registros de la noche saldrían con el folio del día siguiente.
function fechaLima() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const buscar = (tipo) => partes.find((p) => p.type === tipo).value;
  return buscar('year') + buscar('month') + buscar('day');
}

// Los 4 digitos van con `crypto.randomInt` y no con `Math.random()`: el folio
// no es solo una etiqueta, es lo que el bot de WhatsApp usa para enganchar una
// conversacion con una solicitud. Con 9.000 valores por dia la entropia sigue
// siendo baja —eso se arregla haciendo que el bot exija ademas que el telefono
// coincida—, pero al menos deja de ser una secuencia predecible.
function generarFolio() {
  return 'MB-' + fechaLima() + '-' + crypto.randomInt(1000, 10000);
}

// Recorta y limita. El endpoint es público: sin tope, un POST puede meter
// megabytes en una columna de texto.
//
// Solo se aceptan cadenas y numeros: con `String(valor)` a secas, un
// `{"nombre":{}}` pasaba la validacion de obligatorios y quedaba guardado
// literalmente como '[object Object]', y el CRM lo mostraba asi al asesor.
function texto(valor, maximo) {
  if (typeof valor === 'number' && isFinite(valor)) return String(valor).slice(0, maximo);
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, maximo);
}

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'metodo no permitido' });
  }

  // Vercel ya parsea el JSON cuando el Content-Type es application/json,
  // pero si llega como texto plano hay que hacerlo a mano.
  let cuerpo = req.body;
  if (typeof cuerpo === 'string') {
    try {
      cuerpo = JSON.parse(cuerpo);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'json invalido' });
    }
  }
  if (!cuerpo || typeof cuerpo !== 'object') {
    return res.status(400).json({ ok: false, error: 'cuerpo vacio' });
  }

  const registro = {
    nombre: texto(cuerpo.nombre, 120),
    empresa: texto(cuerpo.empresa, 120),
    email: texto(cuerpo.email, 160).toLowerCase(),
    telefono: texto(cuerpo.telefono, 40),
    zona: texto(cuerpo.zona, 60),
    plazo: texto(cuerpo.plazo, 60),
    // El formulario manda las casillas como array; el workflow viejo las
    // unía con ", " y el CRM las lee así. Se mantiene el mismo formato.
    equipos: Array.isArray(cuerpo.equipo)
      ? cuerpo.equipo.map((e) => texto(e, 60)).filter(Boolean).join(', ').slice(0, 400)
      : texto(cuerpo.equipo, 400),
    detalle: texto(cuerpo.detalle, 1000),
    origen: 'landing',
  };

  // Validación del lado del servidor. La landing ya valida, pero el
  // endpoint es público y no puede confiar en eso.
  const faltantes = ['nombre', 'empresa', 'email', 'telefono'].filter(
    (campo) => !registro[campo]
  );
  if (faltantes.length) {
    return res
      .status(400)
      .json({ ok: false, error: 'faltan campos obligatorios: ' + faltantes.join(', ') });
  }
  if (!EMAIL_VALIDO.test(registro.email)) {
    return res.status(400).json({ ok: false, error: 'correo invalido' });
  }

  // Falla temprano y con un mensaje claro: sin esto el error real queda
  // enterrado en un timeout de conexión difícil de leer.
  if (!cadenaConexion()) {
    console.error('registro: falta DATABASE_URL (o POSTGRES_URL)');
    return res.status(500).json({ ok: false, error: 'base de datos no configurada' });
  }

  const sql = `
    INSERT INTO registros
      (folio, nombre, empresa, email, telefono, zona, plazo, equipos, detalle, origen, atendido)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
    RETURNING folio
  `;

  try {
    const cliente = obtenerPool();

    // El folio lleva 4 dígitos al azar dentro del día, así que puede
    // repetirse. Antes nadie lo notaba porque no había restricción; ahora
    // la columna es UNIQUE y se reintenta con otro número.
    for (let intento = 0; intento < 5; intento++) {
      const folio = generarFolio();
      try {
        const r = await cliente.query(sql, [
          folio,
          registro.nombre,
          registro.empresa,
          registro.email,
          registro.telefono,
          registro.zona,
          registro.plazo,
          registro.equipos,
          registro.detalle,
          registro.origen,
        ]);
        return res.status(200).json({ ok: true, folio: r.rows[0].folio });
      } catch (e) {
        // 23505 = unique_violation. Cualquier otro error es real.
        if (e.code !== '23505') throw e;
      }
    }

    console.error('registro: 5 folios colisionaron seguidos');
    return res.status(500).json({ ok: false, error: 'no se pudo generar folio' });
  } catch (e) {
    // El detalle va al log de Vercel, no a la respuesta: puede traer datos
    // de la conexión. La landing solo necesita saber que falló.
    console.error('registro: fallo al guardar', e);
    return res.status(500).json({ ok: false, error: 'no se pudo guardar el registro' });
  }
};
