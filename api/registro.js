// Captura de registros de la landing de Mining Big.
//
// Reemplaza al workflow de n8n "Mining Big — Captura de registros"
// (OYd1k8lm0Sd5oHfc), que se cayó cuando venció la prueba gratuita.
// Misma entrada y misma salida que el webhook viejo, así que la landing
// solo cambia la URL: el body sigue siendo {nombre, empresa, email,
// telefono, zona, plazo, equipo[], detalle} y la respuesta {ok, folio}.

const crypto = require('crypto');
const { obtenerPool, cadenaConexion } = require('../lib/db');
const { crearTope, ipDe } = require('../lib/tope-tasa');

// A diferencia del CRM —que solo cuenta los intentos FALLIDOS de clave— acá se
// cuenta cada registro aceptado: no hay forma de distinguir un envío legítimo
// de uno automático, que es justo el problema. Ver `lib/tope-tasa.js` para por
// qué esto es best-effort.
const topeRegistros = crearTope({ max: 5, ventanaMs: 10 * 60 * 1000 });

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

  // Este endpoint es público y sin autenticación: es un formulario. Sin tope,
  // un script llena `registros` en minutos y el asesor pierde las solicitudes
  // reales entre la basura — o sea que corta la captación sin que nadie vea un
  // error. 5 en 10 minutos es de sobra para una persona llenando un formulario
  // una vez, y sigue permitiendo que dos personas de la misma oficina se
  // registren seguidas.
  const ip = ipDe(req);
  if (topeRegistros.excedido(ip)) {
    res.setHeader('Retry-After', '600');
    return res.status(429).json({
      ok: false,
      error: 'demasiados registros seguidos, probar de nuevo en unos minutos',
    });
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
    const cliente = obtenerPool('registro', { max: 1 });

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
        // Se cuenta acá y no al entrar: así un cliente que se equivoca en el
        // correo y reintenta tres veces no se gasta el cupo con envíos que
        // nunca llegaron a guardarse.
        topeRegistros.anotar(ip);
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
