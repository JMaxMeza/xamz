// Envío de mensajes por la API de WhatsApp Business (Graph API de Meta).
//
// Lo usan el CRM (el asesor escribiendo desde el panel) y el bot (las
// respuestas automáticas). Es el mismo número en los dos casos.

// Devuelve el motivo cuando Meta rechaza —ventana de 24 h vencida, número no
// autorizado— en vez de un booleano pelado: el panel lo muestra tal cual al
// asesor, y decir "enviado" cuando no salió es peor que fallar.
//
// `idNumero` permite pasar el `phone_number_id` que vino en el webhook, en vez
// del de la variable de entorno. El bot lo hace a propósito: así siempre
// responde desde el número que recibió el mensaje y no hay forma de tener un
// identificador mal copiado. El CRM no lo pasa y usa el de entorno, porque
// escribe sin haber recibido nada.

// ── Por qué form-urlencoded y no JSON ────────────────────────────────────────
//
// Costó una jornada entera de diagnóstico (2026-09-01). Con un cuerpo JSON
// —que es lo que muestra media documentación de Cloud API— este endpoint
// responde:
//
//   HTTP 500 {"error":{"message":"An unknown error has occurred.",
//                      "code":1,"type":"OAuthException"}}
//
// Un `OAuthException` que NO es un problema de autenticación: el token, los
// permisos, la suscripción de la app y el estado de la cuenta estaban todos
// bien, y el mismo token enviaba sin problema desde el Explorador de la API.
// Es un error de FORMATO disfrazado de error de credenciales, y por eso manda
// a buscar donde no es.
//
// Los parámetros van en el CUERPO y en formato form. Meta lo dice claro solo si
// uno se equivoca en la otra dirección, mandándolos por query string:
//
//   (#100) POST request should not contain any query params.
//          Please make sure all the required params are in the POST request body.
//
// (Ojo: el cURL que genera el propio Explorador con "Obtener código" pone todo
// en la query string y por lo tanto **no funciona** — devuelve ese #100. El
// Explorador internamente manda form.)
//
// `text` viaja como una cadena JSON dentro del campo form, que es como lo
// espera la API. Detalle completo en
// `wiki/sistemas/bot-faq-whatsapp-mining-big.md`.
async function enviarWhatsApp(telefono, cuerpo, opciones) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const idNumero = (opciones && opciones.idNumero) || process.env.WHATSAPP_PHONE_ID;
  if (!token || !idNumero) {
    return { ok: false, error: 'WhatsApp no configurado en el servidor' };
  }

  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${idNumero}/messages`;
  const quien = (opciones && opciones.quien) || 'whatsapp';

  const campos = new URLSearchParams({
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'text',
    text: JSON.stringify({ body: cuerpo }),
    access_token: token,
  });

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: campos.toString(),
    });
  } catch (e) {
    console.error(`${quien}: no se pudo hablar con la API de WhatsApp`, e);
    return { ok: false, error: 'no se pudo contactar a WhatsApp' };
  }

  if (!respuesta.ok) {
    const json = await respuesta.json().catch(() => null);
    const err = (json && json.error) || {};
    const detalle = err.error_user_msg || err.message || `HTTP ${respuesta.status}`;
    // El mensaje de Meta suele ser genérico; el código, el subcódigo y
    // `error_data.details` son los que dicen qué pasó. Y si vuelve a aparecer
    // un `code: 1` pelado, sospechar del formato de la petición antes que del
    // token — ver el comentario de arriba.
    console.error(`${quien}: WhatsApp rechazó el envío:`, detalle, {
      status: respuesta.status,
      code: err.code,
      subcode: err.error_subcode,
      type: err.type,
      details: err.error_data && err.error_data.details,
      fbtrace_id: err.fbtrace_id,
    });
    return { ok: false, error: detalle };
  }
  return { ok: true };
}

// Manda una imagen ya subida a un storage público (Supabase Storage, ver
// `lib/storage.js`). Mismo motivo de form-urlencoded que `enviarWhatsApp`
// arriba: es la misma API, el mismo token, la misma trampa.
async function enviarImagenWhatsApp(telefono, urlImagen, caption, opciones) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const idNumero = (opciones && opciones.idNumero) || process.env.WHATSAPP_PHONE_ID;
  if (!token || !idNumero) {
    return { ok: false, error: 'WhatsApp no configurado en el servidor' };
  }

  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${idNumero}/messages`;
  const quien = (opciones && opciones.quien) || 'whatsapp';

  const imagen = { link: urlImagen };
  if (caption) imagen.caption = caption;

  const campos = new URLSearchParams({
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'image',
    image: JSON.stringify(imagen),
    access_token: token,
  });

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: campos.toString(),
    });
  } catch (e) {
    console.error(`${quien}: no se pudo hablar con la API de WhatsApp (imagen)`, e);
    return { ok: false, error: 'no se pudo contactar a WhatsApp' };
  }

  if (!respuesta.ok) {
    const json = await respuesta.json().catch(() => null);
    const err = (json && json.error) || {};
    const detalle = err.error_user_msg || err.message || `HTTP ${respuesta.status}`;
    console.error(`${quien}: WhatsApp rechazó el envío de imagen:`, detalle, {
      status: respuesta.status, code: err.code, subcode: err.error_subcode,
    });
    return { ok: false, error: detalle };
  }
  return { ok: true };
}

// ── Descarga de media entrante ────────────────────────────────────────────
//
// Meta no manda el archivo en el webhook, manda un `id`. Con ese id hay que
// pedir la URL temporal (vive unos minutos) y DESPUÉS pedir esa URL — las dos
// llamadas necesitan el mismo Bearer token, la URL temporal no alcanza sola.
// Documentado en https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media

async function resolverUrlMedia(mediaId) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const resp = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`whatsapp: no se pudo resolver el media ${mediaId} (HTTP ${resp.status})`);
  return resp.json(); // { url, mime_type, file_size, sha256, id }
}

async function descargarMedia(urlTemporal) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const resp = await fetch(urlTemporal, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`whatsapp: no se pudo descargar el media (HTTP ${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, mimeType: resp.headers.get('content-type') || '' };
}

module.exports = {
  enviarWhatsApp, enviarImagenWhatsApp, resolverUrlMedia, descargarMedia,
};
