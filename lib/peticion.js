// Lectura cruda de la petición, compartida por los dos webhooks entrantes
// (`api/bot.js` de Meta y `api/correo.js` del proveedor de correo).
//
// Los dos necesitan lo mismo: los BYTES exactos del cuerpo, porque quien firma
// un webhook firma los bytes. `JSON.stringify(req.body)` no los reproduce
// —orden de claves, espacios, escapes— y cualquier HMAC daría distinto siempre.

// Se conserva por compatibilidad, pero NO sirve en Vercel: `bodyParser: false`
// es una convención de Next.js y esto son Serverless Functions comunes, donde
// esa opción no existe. Ver el comentario de `cuerpoCrudo`.
const CONFIG_SIN_PARSEO = { api: { bodyParser: false } };

// Devuelve un Buffer con los bytes exactos, o `null` si ya no se pueden
// recuperar. `null` no es un error: es "no se puede comprobar la firma", que el
// handler decide cómo tratar.
//
// EL ORDEN DE ESTA FUNCIÓN ES LO IMPORTANTE. En Vercel `req.body` es un
// **getter perezoso**: el cuerpo se parsea recién cuando alguien lo toca, y en
// ese momento los bytes originales se pierden. La primera versión de esto
// miraba `req.body` antes de leer el stream, así que ella misma disparaba el
// parseo que quería evitar y después informaba —correctamente— que el cuerpo
// "ya estaba parseado". La firma de Meta llevaba sin comprobarse desde el
// 2026-08-21 por eso.
//
// Ahora se lee el stream PRIMERO y `req.body` solo se mira si no vino nada.
async function cuerpoCrudo(req) {
  try {
    const trozos = [];
    for await (const trozo of req) trozos.push(trozo);
    if (trozos.length) return Buffer.concat(trozos);
  } catch (e) {
    // El stream ya estaba consumido: se cae al plan B de abajo.
  }

  // Plan B: la plataforma ya lo parseó (o alguien tocó `req.body` antes). Solo
  // sirve si quedó como Buffer o cadena; un objeto ya no reproduce los bytes.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  return null;
}

// Vercel llena `req.query`, pero desactivar el parseo del cuerpo es
// suficientemente atípico como para no dar por sentado que lo demás sigue
// intacto: si no está, se saca de la URL, que siempre está.
function consulta(req) {
  if (req.query && typeof req.query === 'object' && Object.keys(req.query).length) {
    return req.query;
  }
  try {
    const u = new URL(req.url, 'http://local');
    return Object.fromEntries(u.searchParams.entries());
  } catch (e) {
    return {};
  }
}

module.exports = { CONFIG_SIN_PARSEO, cuerpoCrudo, consulta };
