// Entrada de correo: las respuestas del cliente.
//
//   POST /api/correo   webhook del proveedor de correo entrante
//
// Es la otra mitad de `lib/correo.js`. El asesor escribe desde el panel y el
// cliente contesta a su cliente de correo de siempre; este endpoint recoge esa
// respuesta y la mete en la tabla `correos`, de modo que en el panel el hilo se
// ve completo — igual que Chats con WhatsApp.
//
// ── Estado: la estructura está, el formato exacto no está verificado ─────────
//
// La firma y el enrutado están hechos y probados. Lo que NO se pudo verificar
// contra algo real es **la forma exacta del payload** que manda el proveedor,
// porque no hay cuenta todavía. Por eso `interpretar()` acepta varias formas
// conocidas y, cuando no reconoce ninguna, **escribe en el log las claves que
// recibió**: el primer correo real que llegue dice qué shape es, y ajustarlo es
// editar una función.
//
// No se inventó una validación de firma específica de proveedor por el mismo
// motivo: cada uno firma distinto (Resend usa Svix, Mailgun HMAC propio) y
// escribir la de uno a ciegas daría una falsa sensación de seguridad. En su
// lugar hay un secreto compartido en cabecera, que **todo** proveedor sabe
// mandar, y un lugar marcado para enchufar la firma real cuando se elija.

const crypto = require('crypto');
const { obtenerPool, cadenaConexion } = require('../lib/db');
const { normalizarEmail, EMAIL_VALIDO } = require('../lib/correo');
const { CONFIG_SIN_PARSEO, cuerpoCrudo } = require('../lib/peticion');

module.exports.config = CONFIG_SIN_PARSEO;

// ── Autenticación ────────────────────────────────────────────────────────────

// A diferencia del bot, acá NO hay modo "pasa igual y avisa". El bot que deja
// pasar un POST falso responde una tontería; este endpoint **escribe en la
// base**, así que sin secreto configurado no se atiende a nadie. Es el mismo
// criterio que `CRM_CLAVE`: que no exista un modo abierto.
function secretoValido(req) {
  const esperado = process.env.CORREO_WEBHOOK_SECRET;
  if (!esperado) return { ok: false, motivo: 'sin CORREO_WEBHOOK_SECRET', configurar: true };

  const recibido = req.headers['x-mb-secreto'] || '';
  const a = Buffer.from(String(recibido));
  const b = Buffer.from(String(esperado));
  if (a.length !== b.length) return { ok: false, motivo: 'secreto con largo distinto' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, motivo: 'secreto incorrecto' };
}

// ── Interpretación del payload ───────────────────────────────────────────────

function primero(...valores) {
  for (const v of valores) {
    if (Array.isArray(v) && v.length) return v[0];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object' && typeof v.address === 'string') return v.address;
    if (v && typeof v === 'object' && typeof v.email === 'string') return v.email;
  }
  return '';
}

// Un `From` viene como 'Yan Meza <yan@ejemplo.com>' tan a menudo como pelado.
function soloDireccion(valor) {
  const s = String(valor || '');
  const m = s.match(/<([^>]+)>/);
  return normalizarEmail(m ? m[1] : s);
}

// Acepta las formas que usan hoy los proveedores más probables. Si mañana el
// elegido manda otra, se agrega acá y nada más se toca.
function interpretar(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  // Resend envuelve el evento: { type: 'email.received', data: { ... } }.
  const d = (cuerpo.data && typeof cuerpo.data === 'object') ? cuerpo.data : cuerpo;
  const cabeceras = d.headers || cuerpo.headers || {};

  const de = soloDireccion(primero(d.from, d.From, d.sender, cuerpo.from));
  if (!de || !EMAIL_VALIDO.test(de)) return null;

  return {
    de,
    asunto: String(primero(d.subject, d.Subject, cuerpo.subject) || '(sin asunto)').slice(0, 300),
    // `text` es el cuerpo en texto plano. Si el cliente escribió en HTML y el
    // proveedor no manda texto, se guarda vacío antes que guardar etiquetas:
    // el asesor lee esto en el panel.
    texto: String(primero(d.text, d['body-plain'], d.plain, cuerpo.text) || '').slice(0, 20000),
    messageId: String(
      primero(d.message_id, d.messageId, cabeceras['message-id'], cabeceras['Message-ID']) || ''
    ).slice(0, 500) || null,
    enRespuestaA: String(
      primero(d.in_reply_to, cabeceras['in-reply-to'], cabeceras['In-Reply-To']) || ''
    ).slice(0, 500) || null,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'metodo no permitido' });
  }

  const permiso = secretoValido(req);
  if (!permiso.ok) {
    if (permiso.configurar) {
      console.error('correo: falta la variable de entorno CORREO_WEBHOOK_SECRET');
      return res.status(500).json({ ok: false, error: 'entrada de correo no configurada' });
    }
    console.error('correo: POST rechazado —', permiso.motivo);
    return res.status(401).json({ ok: false, error: 'no autorizado' });
  }

  const crudo = await cuerpoCrudo(req).catch(() => null);
  let cuerpo = req.body;
  if (crudo) {
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'json invalido' });
    }
  }

  const correo = interpretar(cuerpo);
  if (!correo) {
    // Acá es donde el primer correo real enseña el formato. Se registran solo
    // las CLAVES, nunca los valores: el cuerpo de un correo es dato personal.
    const claves = cuerpo && typeof cuerpo === 'object' ? Object.keys(cuerpo) : typeof cuerpo;
    const clavesData = cuerpo && cuerpo.data && typeof cuerpo.data === 'object'
      ? Object.keys(cuerpo.data) : null;
    console.error(
      'correo: no reconozco el formato del webhook. Claves recibidas:',
      JSON.stringify(claves), 'data:', JSON.stringify(clavesData)
    );
    // 200 para que el proveedor no reintente en bucle algo que no va a mejorar
    // solo. El log ya tiene lo necesario para arreglarlo.
    return res.status(200).json({ ok: false, error: 'formato no reconocido' });
  }

  if (!cadenaConexion()) {
    console.error('correo: falta DATABASE_URL (o POSTGRES_URL)');
    return res.status(500).json({ ok: false, error: 'base de datos no configurada' });
  }

  const bd = obtenerPool('correo');
  try {
    // El folio sale de la solicitud más reciente de ese correo, si la hay. Un
    // correo de alguien que no está en `registros` se guarda igual, con folio
    // NULL: perderlo sería peor que tenerlo suelto.
    const { rows } = await bd.query(
      `SELECT folio FROM registros WHERE lower(email) = $1 ORDER BY id DESC LIMIT 1`,
      [correo.de]
    );
    const folio = rows.length ? rows[0].folio : null;

    const r = await bd.query(
      `INSERT INTO correos (folio, email, direccion, asunto, texto, autor, message_id, en_respuesta_a)
       VALUES ($1, $2, 'in', $3, $4, 'cliente', $5, $6)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [folio, correo.de, correo.asunto, correo.texto, correo.messageId, correo.enRespuestaA]
    );

    if (r.rowCount === 0) {
      return res.status(200).json({ ok: true, ignorado: 'correo repetido' });
    }
    return res.status(200).json({ ok: true, folio: folio || undefined });
  } catch (e) {
    console.error('correo: fallo guardando el correo entrante:', e.message);
    // 500 a propósito, al revés que el bot: acá el correo NO quedó guardado, y
    // que el proveedor reintente es exactamente lo que se quiere.
    return res.status(500).json({ ok: false, error: 'fallo interno' });
  }
};

module.exports.interpretar = interpretar;
module.exports.soloDireccion = soloDireccion;
module.exports.secretoValido = secretoValido;
