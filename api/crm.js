// API del CRM de Mining Big.
//
// Reemplaza al workflow de n8n "CRM Mining Big" (Q53HZ7R1ueJrJqUo), que dejó
// de responder cuando venció la prueba gratuita. Mantiene **el mismo contrato**
// que el webhook viejo —una sola ruta, la acción en el body, la clave en el
// body— para que el panel solo cambie la URL:
//
//   POST /api/crm  { clave, action, ... }
//
//   datos         -> { ok, registros[], conversaciones[], mensajes[], alertas[],
//                       mensajes_recortados }
//   atendido      -> { ok, cambiado }              { folio, atendido }
//   toggle_bot    -> { ok }                        { telefono, activo }
//   alerta_vista  -> { ok, cambiado }              { id }
//   enviar        -> { ok, aviso? } | { ok:false, error }   { telefono, texto }
//
// `cambiado:false` significa que la fila no existe (folio o id que ya no
// estan): el panel lo avisa en vez de dejar que el sondeo revierta el cambio
// sin explicacion. `aviso` en `enviar` significa que el mensaje SI salio pero
// no se pudo guardar en el historial.
//
// Clave incorrecta o ausente -> 401, que es lo que el panel traduce a "volver
// a la pantalla de acceso". Demasiadas claves fallidas seguidas desde la misma
// IP -> 429.

const { Pool, types } = require('pg');
const crypto = require('crypto');
const { CA_SUPABASE } = require('../lib/supabase-ca');

// `pg` devuelve los BIGINT (oid 20) como STRING, porque no siempre caben en un
// Number de JS. El panel compara ids con `===` contra numeros
// (`parseInt(data-vista)`), y "7" === 7 es false: el marcado local no ocurria
// nunca y "Marcar vista" no hacia nada visible hasta el sondeo siguiente.
// Se convierten aca, que es un solo sitio, y solo cuando el valor cabe de
// verdad en un Number; si algun dia no cabe, se deja el string y el problema
// se ve en vez de convertirse en un id equivocado.
types.setTypeParser(20, (valor) => {
  const n = Number(valor);
  return Number.isSafeInteger(n) ? n : valor;
});

// La integración oficial de Supabase con Vercel inyecta `POSTGRES_URL` sola,
// sin que nadie copie la cadena a mano — que es como conviene hacerlo, porque
// lleva la contraseña dentro. `DATABASE_URL` se sigue aceptando para el caso
// de poner la variable a mano o de mudarse a otro Postgres.
function cadenaConexion() {
  const cruda = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!cruda) return '';
  // `pg` deja que lo que venga DENTRO de la cadena pise la configuración que
  // se le pasa aparte, no al revés. Así que un `?sslmode=require` en la URL
  // anula el `ssl: { ca }` de más abajo y la conexión vuelve a morir con
  // SELF_SIGNED_CERT_IN_CHAIN. Se quita ese parámetro para que el TLS se
  // decida en un solo sitio: acá, verificando contra la CA de Supabase.
  try {
    const u = new URL(cruda);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch (e) {
    return cruda;
  }
}

// Una invocación de `datos` hace 4 lecturas en paralelo, así que el pool
// necesita más de una conexión (a diferencia de `registro.js`, que hace un
// solo INSERT). Sigue siendo pequeño: Vercel reutiliza el proceso y un
// Postgres con pooler no debe ver más de un puñado de conexiones por
// instancia.
let pool;
function obtenerPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: cadenaConexion(),
      // Verificar contra la CA de Supabase, no contra el almacén de Node.
      // Se pasa explícito y gana sobre lo que diga el `sslmode` de la cadena.
      ssl: { ca: CA_SUPABASE },
      max: 4,
      idleTimeoutMillis: 10000,
      // El limite por defecto de una funcion Node en Vercel es 10 s. Con 8 s
      // esperando la conexion, un arranque en frio con la base tambien fria
      // se comia el presupuesto entero y la plataforma cortaba con un 504 sin
      // JSON, que el panel muestra como "error del servidor" sin mas. Con 5 s
      // quedan otros 5 para las consultas.
      connectionTimeoutMillis: 5000,
      // Y que una consulta colgada no se lleve por delante el resto de la
      // invocacion: se corta sola y el error se ve en el log. Es el corte del
      // lado del cliente (un temporizador de `pg`), no `statement_timeout`:
      // ese viaja en los parametros de arranque de la conexion y un pooler en
      // modo transaccion puede rechazarlo, y entonces no falla una consulta,
      // falla la conexion entera.
      query_timeout: 6000,
    });
    // Sin oyente, el error de una conexión ociosa caída tumba el proceso.
    pool.on('error', (err) => {
      console.error('crm: conexión ociosa del pool caída:', err.message);
    });
  }
  return pool;
}

// Compara sin filtrar la respuesta por el tiempo que tarda. Se comparan los
// SHA-256, no las cadenas: asi los dos buffers miden siempre 32 bytes y el
// atajo por longitud distinta —que era el unico camino rapido que quedaba, y
// dejaba adivinar el largo de la clave— desaparece.
function claveValida(recibida) {
  const esperada = process.env.CRM_CLAVE || '';
  if (!esperada) return false;
  const a = crypto.createHash('sha256').update(String(recibida === null || recibida === undefined ? '' : recibida), 'utf8').digest();
  const b = crypto.createHash('sha256').update(esperada, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Tope de tasa para los intentos de clave fallidos ──
//
// Es best-effort a proposito: el contador vive en la memoria de la instancia y
// Vercel puede levantar varias, asi que no sustituye a un limitador de verdad
// (eso necesitaria almacenamiento compartido). Lo que corta es el caso real
// que describe el README: alguien probando claves a mano o con un script
// simple contra el endpoint. Solo se cuentan los FALLOS: una clave correcta
// nunca suma, de modo que el asesor no se puede autobloquear.
const FALLOS_MAX = 10;
const FALLOS_VENTANA_MS = 5 * 60 * 1000;
const FALLOS_MAX_IPS = 500; // tope de memoria: la tabla no puede crecer sola
const fallos = new Map();

function ipDe(req) {
  const cabeceras = (req && req.headers) || {};
  const cruda = cabeceras['x-forwarded-for'] || cabeceras['x-real-ip'] || '';
  const primera = String(Array.isArray(cruda) ? cruda[0] : cruda).split(',')[0].trim();
  return primera || (req && req.socket && req.socket.remoteAddress) || 'sin-ip';
}

function demasiadosFallos(ip) {
  const registro = fallos.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > FALLOS_VENTANA_MS) {
    fallos.delete(ip);
    return false;
  }
  return registro.intentos >= FALLOS_MAX;
}

function anotarFallo(ip) {
  const ahora = Date.now();
  const registro = fallos.get(ip);
  if (!registro || ahora - registro.desde > FALLOS_VENTANA_MS) {
    fallos.set(ip, { intentos: 1, desde: ahora });
  } else {
    registro.intentos++;
  }
  if (fallos.size > FALLOS_MAX_IPS) {
    for (const [clave, valor] of fallos) {
      if (ahora - valor.desde > FALLOS_VENTANA_MS) fallos.delete(clave);
    }
    // Si aun asi no baja, se vacia: perder el conteo es preferible a que la
    // tabla crezca sin techo en un proceso que vive horas.
    if (fallos.size > FALLOS_MAX_IPS) fallos.clear();
  }
}

// El formulario manda '+51 999 888 777' y WhatsApp '51999888777'. Se guarda
// siempre en dígitos para que las dos puntas se encuentren.
function soloDigitos(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/\D/g, '')
    .slice(0, 20);
}

function texto(valor, maximo) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim().slice(0, maximo);
}

// El panel lee `createdAt` en camelCase (viene de la data table de n8n) y en
// Postgres la columna es `creado_en`. Se traduce acá y no en el panel: es una
// línea en un lugar, contra siete en el front.
const COMO_REGISTRO = `
  id, folio, nombre, empresa, email, telefono, zona, plazo, equipos,
  detalle, atendido, creado_en AS "createdAt"
`;

// Tope de mensajes que viaja en cada sondeo. El panel se trae el historial
// completo cada 45 s y lo filtra en el navegador; sin tope, el día que haya
// 50 000 mensajes cada sondeo movería megabytes. 4 000 cubre con holgura el
// volumen real y el corte se avisa en la respuesta.
const TOPE_MENSAJES = 4000;

async function leerTodo(bd) {
  const [registros, conversaciones, mensajes, alertas] = await Promise.all([
    bd.query(`SELECT ${COMO_REGISTRO} FROM registros ORDER BY id DESC`),
    bd.query(`
      SELECT telefono, folio, estado, unidades, cuando, duracion, operador,
             acceso, altitud, bot_activo, creado_en AS "createdAt"
        FROM conversaciones ORDER BY actualizado_en DESC
    `),
    // Se piden los más NUEVOS y después se dan vuelta: recortar por el final
    // dejaría al asesor mirando los mensajes más viejos del sistema.
    // El tope va como parámetro y no interpolado aunque sea una constante
    // nuestra: así la regla "ningún VALOR entra al SQL por plantilla" se
    // sostiene sola. Lo único que sigue interpolado es `COMO_REGISTRO`, que
    // es una lista de columnas — eso no se puede parametrizar en SQL.
    bd.query(
      `SELECT id, telefono, direccion, texto, autor, creado_en AS "createdAt"
         FROM mensajes ORDER BY id DESC LIMIT $1`,
      [TOPE_MENSAJES]
    ),
    bd.query(`
      SELECT id, telefono, folio, motivo, atendida, creado_en AS "createdAt"
        FROM alertas ORDER BY id DESC
    `),
  ]);

  return {
    ok: true,
    registros: registros.rows,
    conversaciones: conversaciones.rows,
    mensajes: mensajes.rows.reverse(),
    alertas: alertas.rows,
    // Para que el panel pueda avisar si algún día se está perdiendo historial.
    mensajes_recortados: mensajes.rows.length >= TOPE_MENSAJES,
  };
}

// Manda el texto por la API de WhatsApp Business con el mismo número del bot.
// Devuelve el motivo cuando Meta rechaza —ventana de 24 h vencida, número no
// autorizado— porque el panel lo muestra tal cual: decir "enviado" cuando no
// salió es peor que fallar.
async function enviarWhatsApp(telefono, cuerpo) {
  const token = process.env.WHATSAPP_TOKEN;
  const idNumero = process.env.WHATSAPP_PHONE_ID;
  if (!token || !idNumero) {
    return { ok: false, error: 'WhatsApp no configurado en el servidor' };
  }

  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${idNumero}/messages`;

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: telefono,
        type: 'text',
        text: { preview_url: false, body: cuerpo },
      }),
    });
  } catch (e) {
    console.error('crm: no se pudo hablar con la API de WhatsApp', e);
    return { ok: false, error: 'no se pudo contactar a WhatsApp' };
  }

  const json = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    const detalle =
      (json && json.error && (json.error.error_user_msg || json.error.message)) ||
      `HTTP ${respuesta.status}`;
    console.error('crm: WhatsApp rechazó el envío:', detalle);
    return { ok: false, error: detalle };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  // El panel se sirve del mismo dominio (`/crm/` y `/api/crm`), así que no
  // hace falta abrir CORS a todo el mundo. Ojo: NO se manda
  // `Access-Control-Allow-Origin`, o sea que el endpoint es de hecho de mismo
  // origen y el preflight de abajo no habilita a nadie — es solo una respuesta
  // limpia al OPTIONS. Si algun dia hay que abrirlo a otro origen, hay que
  // agregar el Allow-Origin con el dominio concreto, nunca `*`.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Las respuestas llevan datos personales de clientes: que no queden en el
  // cache del navegador ni en ningun intermedio.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'metodo no permitido' });
  }

  let cuerpo = req.body;
  // Vercel entrega un objeto ya parseado cuando el Content-Type es JSON, pero
  // con otro Content-Type llega como string o como Buffer sin tocar.
  if (Buffer.isBuffer(cuerpo)) cuerpo = cuerpo.toString('utf8');
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

  if (!process.env.CRM_CLAVE) {
    console.error('crm: falta la variable de entorno CRM_CLAVE');
    return res.status(500).json({ ok: false, error: 'panel no configurado' });
  }
  // La clave se valida ANTES de mirar el tope de tasa, y el orden importa:
  // al reves, una oficina detras de una sola IP quedaba bloqueada 5 minutos
  // porque alguien escribio mal la clave 10 veces, y el asesor con la clave
  // buena tampoco podia entrar. Validar primero no afloja nada contra la
  // fuerza bruta —quien no tiene la clave sigue fallando y sumando— y cuesta
  // un SHA-256 por request.
  const ip = ipDe(req);
  if (!claveValida(cuerpo.clave)) {
    anotarFallo(ip);
    if (demasiadosFallos(ip)) {
      res.setHeader('Retry-After', '300');
      return res
        .status(429)
        .json({ ok: false, error: 'demasiados intentos, probar de nuevo en unos minutos' });
    }
    return res.status(401).json({ ok: false, error: 'clave incorrecta' });
  }
  fallos.delete(ip);

  if (!cadenaConexion()) {
    console.error('crm: falta DATABASE_URL (o POSTGRES_URL)');
    return res.status(500).json({ ok: false, error: 'base de datos no configurada' });
  }

  const bd = obtenerPool();
  const accion = texto(cuerpo.action, 30);

  try {
    switch (accion) {
      case 'datos':
        return res.status(200).json(await leerTodo(bd));

      case 'atendido': {
        const folio = texto(cuerpo.folio, 40);
        if (!folio) {
          return res.status(400).json({ ok: false, error: 'falta el folio' });
        }
        const r = await bd.query('UPDATE registros SET atendido = $1 WHERE folio = $2', [
          cuerpo.atendido === true,
          folio,
        ]);
        // `cambiado` deja que el panel distinga "guardado" de "esa solicitud
        // ya no esta en la base". Sin esto, el check se marcaba, el servidor
        // decia ok y a los 45 s el sondeo lo devolvia al estado anterior sin
        // que nadie pudiera explicar por que.
        return res.status(200).json({ ok: true, cambiado: r.rowCount > 0 });
      }

      case 'toggle_bot': {
        const telefono = soloDigitos(cuerpo.telefono);
        if (!telefono) {
          return res.status(400).json({ ok: false, error: 'falta el telefono' });
        }
        // Upsert: el asesor puede apagar el bot en un chat que todavía no
        // tiene fila en conversaciones (el bot la crea al primer mensaje).
        await bd.query(
          `INSERT INTO conversaciones (telefono, bot_activo)
                VALUES ($1, $2)
           ON CONFLICT (telefono) DO UPDATE
                   SET bot_activo = EXCLUDED.bot_activo,
                       actualizado_en = now()`,
          [telefono, cuerpo.activo === true]
        );
        return res.status(200).json({ ok: true });
      }

      case 'alerta_vista': {
        // Los ids de `alertas` son IDENTITY, o sea >= 1: un 0 o un negativo es
        // siempre un error de quien llama, no una fila que ya no esta.
        const id = Number.parseInt(cuerpo.id, 10);
        if (!Number.isInteger(id) || id < 1) {
          return res.status(400).json({ ok: false, error: 'id invalido' });
        }
        const r = await bd.query('UPDATE alertas SET atendida = true WHERE id = $1', [id]);
        return res.status(200).json({ ok: true, cambiado: r.rowCount > 0 });
      }

      case 'enviar': {
        const telefono = soloDigitos(cuerpo.telefono);
        const mensaje = texto(cuerpo.texto, 4000);
        if (!telefono || !mensaje) {
          return res.status(400).json({ ok: false, error: 'falta telefono o texto' });
        }

        const envio = await enviarWhatsApp(telefono, mensaje);
        // Solo se registra lo que Meta aceptó. Guardar el mensaje igual
        // dejaría en el hilo una respuesta que el cliente nunca recibió, y el
        // asesor la leería como enviada.
        if (!envio.ok) return res.status(200).json(envio);

        // A partir de aca el mensaje YA salio. Si el INSERT falla, contestar
        // 500 haria que el asesor lo reenviara y el cliente recibiria el
        // mismo texto dos veces; se responde ok con un aviso, que es lo unico
        // cierto: salio, pero no quedo en el historial.
        try {
          await bd.query(
            `INSERT INTO mensajes (telefono, direccion, texto, autor)
                  VALUES ($1, 'out', $2, 'asesor')`,
            [telefono, mensaje]
          );
        } catch (e) {
          console.error('crm: mensaje enviado a WhatsApp pero no registrado en la base', e);
          return res.status(200).json({
            ok: true,
            aviso: 'el mensaje salio, pero no se pudo guardar en el historial',
          });
        }
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: 'accion desconocida' });
    }
  } catch (e) {
    // El detalle va al log de Vercel, no a la respuesta: puede traer datos de
    // la conexión.
    console.error(`crm: fallo en la accion '${accion}'`, e);
    return res.status(500).json({ ok: false, error: 'error del servidor' });
  }
};
