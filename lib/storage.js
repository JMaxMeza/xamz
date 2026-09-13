// Sube archivos al bucket de Supabase Storage para los adjuntos de WhatsApp
// (fotos que manda el cliente, fotos que manda el asesor).
//
// Usa la API REST de Storage directo con `fetch`, no el SDK de Supabase: la
// app no tiene más dependencia que `pg` (ver `lib/db.js`), y esto es un PUT
// y listo — no hace falta cargar un cliente entero por eso.
//
// Necesita dos variables de entorno que HOY no existen en el proyecto:
//   SUPABASE_URL              → https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY → la clave "service_role" (no la "anon"),
//                                 Settings > API del proyecto en Supabase.
// Sin ellas, `subirArchivo` tira un error claro en vez de fallar callado;
// quien llama decide qué hacer (ver `api/bot.js` y `api/crm.js`, que las dos
// caen a un mensaje de texto avisando que la imagen no se pudo procesar).

const BUCKET = 'whatsapp-media';

function configuracion() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, clave };
}

function configurado() {
  const { url, clave } = configuracion();
  return Boolean(url && clave);
}

// `ruta` incluye la extensión (p. ej. `entrantes/51999.../<wa_id>.jpg`). Se
// arma afuera para que quien suba decida el nombre; acá solo se sube.
async function subirArchivo(ruta, bytes, mimeType) {
  const { url, clave } = configuracion();
  if (!url || !clave) {
    throw new Error('Supabase Storage no configurado (falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY)');
  }
  const resp = await fetch(`${url}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clave}`,
      'Content-Type': mimeType || 'application/octet-stream',
      // Sin esto, subir dos veces la misma ruta (reintento de Meta, por
      // ejemplo) devuelve 400 "Duplicate" en vez de sobrescribir.
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`storage: subida fallo (HTTP ${resp.status}) ${detalle.slice(0, 200)}`);
  }
  // El bucket es publico (ver db/media-2026-09-04.sql): la URL de lectura no
  // necesita firma ni token, cualquiera con el link la ve. La ruta lleva un
  // componente opaco (wa_id o un uuid) para que no sea adivinable en la
  // práctica, mismo criterio de "seguridad por URL larga" que ya usa Meta
  // para sus propios links de media temporales.
  return `${url}/storage/v1/object/public/${BUCKET}/${ruta}`;
}

module.exports = { subirArchivo, configurado, BUCKET };
