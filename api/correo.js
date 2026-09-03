// Entrada de correo: las respuestas del cliente.
//
//   POST /api/correo   webhook del proveedor de correo entrante
//
// Es la otra mitad de `lib/correo.js`. El asesor escribe desde el panel y el
// cliente contesta a su cliente de correo de siempre; este endpoint recoge esa
// respuesta y la mete en la tabla `correos`, de modo que en el panel el hilo se
// ve completo — igual que Chats con WhatsApp.
//
// ── Estado: probado de punta a punta contra Resend real (2026-09-02) ─────────
//
// La firma quedó cerrada el 2026-09-01: Resend delega el envío de webhooks en
// Svix, así que se verifica la firma Svix real en vez de un secreto compartido
// en cabecera. Referencia:
// https://docs.svix.com/receiving/verifying-payloads/how-manual
//
// El payload del webhook, confirmado con un correo real:
//   { type: 'email.received', data: { from, to, subject, message_id,
//     email_id, received_for, created_at, attachments, cc, bcc } }
// SIN `text` NI `html`. La primera versión de este archivo asumía que el
// cuerpo venía en el propio webhook (como Mailgun o Postmark) — para Resend
// es al revés: el webhook es solo una notificación con `data.email_id`, y el
// cuerpo real hay que pedirlo aparte con
// `GET https://api.resend.com/emails/receiving/{email_id}`. Confirmado contra
// la documentación oficial:
// https://resend.com/docs/api-reference/emails/retrieve-received-email
// Sin este segundo viaje, el correo se guardaba con folio y remitente
// correctos y el cuerpo vacío — no fallaba, así que no se notaba solo.

const crypto = require('crypto');
const { obtenerPool, cadenaConexion } = require('../lib/db');
const { normalizarEmail, EMAIL_VALIDO } = require('../lib/correo');
const { CONFIG_SIN_PARSEO, cuerpoCrudo } = require('../lib/peticion');

module.exports.config = CONFIG_SIN_PARSEO;

// ── Autenticación (firma Svix de Resend) ─────────────────────────────────────

// Svix recomienda esta ventana contra ataques de repetición: un atacante que
// capturó un webhook viejo no puede reenviarlo pasado este tiempo, aun con la
// firma intacta.
const TOLERANCIA_RELOJ_SEG = 5 * 60;

// A diferencia del bot, acá NO hay modo "pasa igual y avisa". El bot que deja
// pasar un POST falso responde una tontería; este endpoint **escribe en la
// base**, así que sin firma comprobada no se atiende a nadie. Es el mismo
// criterio que `CRM_CLAVE`: que no exista un modo abierto.
//
// `CORREO_WEBHOOK_SECRET` ya no es el secreto arbitrario de antes: es el
// *signing secret* que la propia consola de Resend entrega al crear el
// endpoint del webhook (empieza con `whsec_`). Mismo nombre de variable,
// contenido distinto — hay que reemplazarlo al conectar el proveedor real.
function firmaValida(crudo, cabeceras) {
  const secreto = process.env.CORREO_WEBHOOK_SECRET;
  if (!secreto) return { ok: false, motivo: 'sin CORREO_WEBHOOK_SECRET', configurar: true };
  if (!crudo) return { ok: false, motivo: 'no se pudo leer el cuerpo crudo: no se puede comprobar la firma' };

  const id = cabeceras['svix-id'];
  const marca = cabeceras['svix-timestamp'];
  const firmas = cabeceras['svix-signature'];
  if (!id || !marca || !firmas) return { ok: false, motivo: 'faltan cabeceras svix-*' };

  const segundos = Number(marca);
  if (!Number.isFinite(segundos)) return { ok: false, motivo: 'svix-timestamp invalido' };
  if (Math.abs(Date.now() / 1000 - segundos) > TOLERANCIA_RELOJ_SEG) {
    return { ok: false, motivo: 'svix-timestamp fuera de tolerancia (posible repeticion)' };
  }

  // El secreto de Svix viaja como 'whsec_' + base64: sin sacar el prefijo se
  // firma con la cadena de texto entera en vez de con la clave real, y el HMAC
  // no coincide nunca aunque el secreto esté bien copiado.
  const base64Secreto = secreto.startsWith('whsec_') ? secreto.slice('whsec_'.length) : secreto;
  let claveBytes;
  try {
    claveBytes = Buffer.from(base64Secreto, 'base64');
  } catch (e) {
    return { ok: false, motivo: 'CORREO_WEBHOOK_SECRET no tiene forma de secreto Svix' };
  }

  const contenidoFirmado = `${id}.${marca}.${crudo.toString('utf8')}`;
  const esperadaBuf = crypto.createHmac('sha256', claveBytes).update(contenidoFirmado).digest();

  // `svix-signature` trae una o más firmas separadas por espacio —Svix manda
  // varias durante una rotación de secreto—, cada una 'v1,<base64>'. Alcanza
  // con que UNA coincida.
  const candidatas = String(firmas).split(' ').map((s) => s.trim()).filter(Boolean);
  for (const candidata of candidatas) {
    const [version, valor] = candidata.split(',');
    if (version !== 'v1' || !valor) continue;
    let candidataBuf;
    try {
      candidataBuf = Buffer.from(valor, 'base64');
    } catch (e) {
      continue;
    }
    if (candidataBuf.length === esperadaBuf.length && crypto.timingSafeEqual(candidataBuf, esperadaBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, motivo: 'ninguna firma svix-signature coincide' };
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
// elegido manda otra, se agrega acá y nada más se toca. `texto` casi siempre
// sale vacío de acá con Resend a propósito — ver `obtenerCorreoCompleto()`.
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
    // `text` es el cuerpo en texto plano. Si el proveedor no lo manda en el
    // webhook (Resend: nunca), se completa con `obtenerCorreoCompleto()` más
    // abajo; si ESO también falla, se guarda vacío antes que guardar
    // etiquetas HTML — el asesor lee esto en el panel.
    texto: String(primero(d.text, d['body-plain'], d.plain, cuerpo.text) || '').slice(0, 20000),
    messageId: String(
      primero(d.message_id, d.messageId, cabeceras['message-id'], cabeceras['Message-ID']) || ''
    ).slice(0, 500) || null,
    enRespuestaA: String(
      primero(d.in_reply_to, cabeceras['in-reply-to'], cabeceras['In-Reply-To']) || ''
    ).slice(0, 500) || null,
    // El id INTERNO de Resend para este correo (no el Message-ID de RFC822):
    // hace falta para pedir el cuerpo. Los demás proveedores no lo mandan, y
    // `obtenerCorreoCompleto()` ya sabe no hacer nada sin esto.
    emailId: String(primero(d.email_id, d.id) || '') || null,
  };
}

// El webhook de Resend es una notificación, no el correo: `text` y `html`
// viven en la API de recepción, no en el payload que llega a este endpoint.
// Confirmado el 2026-09-02 contra un correo real y contra la documentación
// oficial (ver la nota de arriba). Devuelve `{ texto, enRespuestaA }` o
// `null` si no se pudo traer — el llamador decide si eso amerita reintento.
async function obtenerCorreoCompleto(emailId) {
  const clave = process.env.CORREO_API_KEY;
  if (!clave) {
    console.error('correo: falta CORREO_API_KEY, no se puede pedir el cuerpo del correo entrante');
    return null;
  }
  let respuesta;
  try {
    respuesta = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${clave}` },
    });
  } catch (e) {
    console.error('correo: no se pudo contactar la API de recepción de Resend:', e.message);
    return null;
  }
  if (!respuesta.ok) {
    console.error('correo: la API de recepción de Resend respondió', respuesta.status);
    return null;
  }
  const detalle = await respuesta.json().catch(() => null);
  if (!detalle) return null;
  const cabeceras = (detalle.headers && typeof detalle.headers === 'object') ? detalle.headers : {};
  return {
    texto: String(detalle.text || '').slice(0, 20000),
    enRespuestaA: String(
      primero(cabeceras['in-reply-to'], cabeceras['In-Reply-To']) || ''
    ).slice(0, 500) || null,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'metodo no permitido' });
  }

  // La firma se computa sobre los BYTES exactos: tiene que leerse antes que
  // nada le dispare el parseo perezoso de `req.body` (ver `lib/peticion.js`).
  const crudo = await cuerpoCrudo(req).catch(() => null);

  const permiso = firmaValida(crudo, req.headers);
  if (!permiso.ok) {
    if (permiso.configurar) {
      console.error('correo: falta la variable de entorno CORREO_WEBHOOK_SECRET');
      return res.status(500).json({ ok: false, error: 'entrada de correo no configurada' });
    }
    console.error('correo: POST rechazado —', permiso.motivo);
    return res.status(401).json({ ok: false, error: 'no autorizado' });
  }

  // `req.body` solo se toca si no hubo bytes crudos: es un getter perezoso y
  // leerlo dispara el parseo que se quiere evitar. Ver `lib/peticion.js`.
  let cuerpo;
  if (crudo) {
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'json invalido' });
    }
  } else {
    cuerpo = req.body;
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

  // Resend nunca manda el cuerpo en el webhook: hay que pedirlo aparte. Si la
  // API de recepción falla (no la falta de la clave, que no se arregla sola),
  // se corta acá con 500 para que Resend reintente el webhook completo más
  // tarde — guardar el correo con el cuerpo vacío sería peor que tardar un
  // poco más en tenerlo bien.
  if (correo.emailId && !correo.texto) {
    const completo = await obtenerCorreoCompleto(correo.emailId);
    if (completo) {
      correo.texto = completo.texto;
      if (completo.enRespuestaA) correo.enRespuestaA = completo.enRespuestaA;
    } else if (process.env.CORREO_API_KEY) {
      // Con la clave puesta, un fallo acá es de red o de la API de Resend:
      // vale la pena que Resend reintente. Sin la clave, reintentar no
      // cambia nada — se sigue de largo y se guarda con el cuerpo vacío,
      // igual que un proveedor que de verdad no manda texto.
      console.error('correo: no se pudo completar el cuerpo del correo', correo.emailId, '— se reintentará');
      return res.status(500).json({ ok: false, error: 'no se pudo completar el correo' });
    }
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
module.exports.obtenerCorreoCompleto = obtenerCorreoCompleto;
module.exports.soloDireccion = soloDireccion;
module.exports.firmaValida = firmaValida;
