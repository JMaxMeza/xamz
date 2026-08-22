// Lectura cruda de la petición, compartida por los dos webhooks entrantes
// (`api/bot.js` de Meta y `api/correo.js` del proveedor de correo).
//
// Los dos necesitan lo mismo: los BYTES exactos del cuerpo, porque quien firma
// un webhook firma los bytes. `JSON.stringify(req.body)` no los reproduce
// —orden de claves, espacios, escapes— y cualquier HMAC daría distinto siempre.

// Se pide en los handlers con `module.exports.config = CONFIG_SIN_PARSEO`.
const CONFIG_SIN_PARSEO = { api: { bodyParser: false } };

// Devuelve un Buffer, o `null` si la plataforma ya parseó el cuerpo a objeto y
// los bytes originales se perdieron. `null` no es un error: es "no se puede
// comprobar la firma", que el handler decide cómo tratar.
async function cuerpoCrudo(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body && typeof req.body === 'object') return null;

  const trozos = [];
  for await (const trozo of req) trozos.push(trozo);
  return Buffer.concat(trozos);
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
