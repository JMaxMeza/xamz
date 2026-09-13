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
//                       correos[], mensajes_recortados }
//   atendido      -> { ok, cambiado }              { folio, atendido }
//   cambiar_etapa -> { ok, cambiado }              { folio, etapa }
//   toggle_bot    -> { ok }                        { telefono, activo }
//   alerta_vista  -> { ok, cambiado }              { id }
//   enviar        -> { ok, aviso? } | { ok:false, error }   { telefono, texto }
//   enviar_imagen -> { ok, aviso? } | { ok:false, error }   { telefono, datos (base64), mimeType, caption? }
//   enviar_correo -> { ok, aviso? } | { ok:false, error }   { email, asunto, texto, folio? }
//
// `cambiado:false` significa que la fila no existe (folio o id que ya no
// estan): el panel lo avisa en vez de dejar que el sondeo revierta el cambio
// sin explicacion. `aviso` en `enviar` significa que el mensaje SI salio pero
// no se pudo guardar en el historial.
//
// Clave incorrecta o ausente -> 401, que es lo que el panel traduce a "volver
// a la pantalla de acceso". Demasiadas claves fallidas seguidas desde la misma
// IP -> 429.

const crypto = require('crypto');
const { obtenerPool, cadenaConexion, soloDigitos } = require('../lib/db');
const { enviarWhatsApp, enviarImagenWhatsApp } = require('../lib/whatsapp');
const { subirArchivo } = require('../lib/storage');
const { enviarCorreo, normalizarEmail } = require('../lib/correo');
const { crearTope, ipDe } = require('../lib/tope-tasa');

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

// Tope de tasa: 10 claves fallidas por IP en 5 minutos. Solo se cuentan los
// FALLOS, de modo que el asesor no se puede autobloquear. El detalle de por
// que es best-effort esta en `lib/tope-tasa.js`.
const topeClaves = crearTope({ max: 10, ventanaMs: 5 * 60 * 1000 });

function texto(valor, maximo) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim().slice(0, maximo);
}

// El panel lee `createdAt` en camelCase (viene de la data table de n8n) y en
// Postgres la columna es `creado_en`. Se traduce acá y no en el panel: es una
// línea en un lugar, contra siete en el front.
const COMO_REGISTRO = `
  id, folio, nombre, empresa, email, telefono, zona, plazo, equipos,
  detalle, atendido, etapa, creado_en AS "createdAt"
`;

// Mismas 6 etapas que el CHECK de la base (db/schema.sql, db/etapas-2026-09-04.sql).
// Se repite acá en vez de leerla de la base porque es una lista fija y
// consultarla en cada request sería una vuelta extra sin ninguna ganancia.
const ETAPAS_VALIDAS = new Set([
  'nuevo', 'contactado', 'cotizado', 'negociando', 'ganado', 'perdido',
]);

// Tope de mensajes que viaja en cada sondeo. El panel se trae el historial
// completo cada 45 s y lo filtra en el navegador; sin tope, el día que haya
// 50 000 mensajes cada sondeo movería megabytes. 4 000 cubre con holgura el
// volumen real y el corte se avisa en la respuesta.
const TOPE_MENSAJES = 4000;

// Los correos también se topan: el panel arma el hilo en el navegador, igual
// que con los mensajes. Es más bajo que el de WhatsApp porque un correo pesa
// mucho más que un mensaje de chat.
const TOPE_CORREOS = 1000;

async function leerTodo(bd) {
  const [registros, conversaciones, mensajes, alertas, correos] = await Promise.all([
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
      `SELECT id, telefono, direccion, texto, autor, media_url AS "mediaUrl",
              media_tipo AS "mediaTipo", creado_en AS "createdAt"
         FROM mensajes ORDER BY id DESC LIMIT $1`,
      [TOPE_MENSAJES]
    ),
    bd.query(`
      SELECT id, telefono, folio, motivo, atendida, creado_en AS "createdAt"
        FROM alertas ORDER BY id DESC
    `),
    bd.query(
      `SELECT id, folio, email, direccion, asunto, texto, autor,
              message_id AS "messageId", creado_en AS "createdAt"
         FROM correos ORDER BY id DESC LIMIT $1`,
      [TOPE_CORREOS]
    ),
  ]);

  return {
    ok: true,
    registros: registros.rows,
    conversaciones: conversaciones.rows,
    mensajes: mensajes.rows.reverse(),
    alertas: alertas.rows,
    correos: correos.rows.reverse(),
    // Para que el panel pueda avisar si algún día se está perdiendo historial.
    mensajes_recortados: mensajes.rows.length >= TOPE_MENSAJES,
    correos_recortados: correos.rows.length >= TOPE_CORREOS,
  };
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
    topeClaves.anotar(ip);
    if (topeClaves.excedido(ip)) {
      res.setHeader('Retry-After', '300');
      return res
        .status(429)
        .json({ ok: false, error: 'demasiados intentos, probar de nuevo en unos minutos' });
    }
    return res.status(401).json({ ok: false, error: 'clave incorrecta' });
  }
  topeClaves.limpiar(ip);

  if (!cadenaConexion()) {
    console.error('crm: falta DATABASE_URL (o POSTGRES_URL)');
    return res.status(500).json({ ok: false, error: 'base de datos no configurada' });
  }

  const bd = obtenerPool('crm');
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

      case 'cambiar_etapa': {
        const folio = texto(cuerpo.folio, 40);
        const etapa = texto(cuerpo.etapa, 20);
        if (!folio || !ETAPAS_VALIDAS.has(etapa)) {
          return res.status(400).json({ ok: false, error: 'falta el folio o la etapa no es valida' });
        }
        const r = await bd.query('UPDATE registros SET etapa = $1 WHERE folio = $2', [etapa, folio]);
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

        const envio = await enviarWhatsApp(telefono, mensaje, { quien: 'crm' });
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

      // Mismo contrato y mismas reglas que `enviar`, pero con un adjunto en
      // vez de (o ademas de) texto. `datos` no pasa por `texto()`: es base64
      // de una imagen entera, y truncarla a `maximo` la corrompería en
      // silencio — exactamente la clase de fallo que esta API evita en todo
      // lo demás.
      case 'enviar_imagen': {
        const telefono = soloDigitos(cuerpo.telefono);
        const datosBase64 = typeof cuerpo.datos === 'string' ? cuerpo.datos : '';
        const mimeType = texto(cuerpo.mimeType, 50) || 'image/jpeg';
        const caption = texto(cuerpo.caption, 1000);
        if (!telefono || !datosBase64) {
          return res.status(400).json({ ok: false, error: 'falta telefono o imagen' });
        }
        // 3 MB de archivo original ⇒ ~4 MB en base64. Vercel topa el cuerpo
        // de una función serverless en ~4.5 MB; con margen para el resto del
        // JSON, 3 MB es el limite real, no uno arbitrario.
        const LIMITE_BYTES = 3 * 1024 * 1024;
        const tamanoAprox = Math.ceil((datosBase64.length * 3) / 4);
        if (tamanoAprox > LIMITE_BYTES) {
          return res.status(400).json({ ok: false, error: 'la imagen supera el límite de 3 MB' });
        }

        let bytes;
        try {
          bytes = Buffer.from(datosBase64, 'base64');
        } catch (e) {
          return res.status(400).json({ ok: false, error: 'imagen invalida (base64)' });
        }

        const extension = (mimeType.split('/')[1] || 'jpg').split(';')[0];
        const ruta = `salientes/${crypto.randomUUID()}.${extension}`;
        let urlPublica;
        try {
          urlPublica = await subirArchivo(ruta, bytes, mimeType);
        } catch (e) {
          console.error('crm: no se pudo subir la imagen a Storage', e.message);
          return res.status(200).json({ ok: false, error: 'no se pudo subir la imagen: ' + e.message });
        }

        const envio = await enviarImagenWhatsApp(telefono, urlPublica, caption);
        if (!envio.ok) return res.status(200).json(envio);

        try {
          await bd.query(
            `INSERT INTO mensajes (telefono, direccion, texto, autor, media_url, media_tipo)
                  VALUES ($1, 'out', $2, 'asesor', $3, 'image')`,
            [telefono, caption, urlPublica]
          );
        } catch (e) {
          console.error('crm: imagen enviada a WhatsApp pero no registrada en la base', e);
          return res.status(200).json({
            ok: true,
            aviso: 'la imagen salio, pero no se pudo guardar en el historial',
          });
        }
        return res.status(200).json({ ok: true });
      }

      // Mismo contrato y mismas reglas que `enviar`, por el otro canal. El
      // correo no tiene la ventana de 24 h de Meta, así que es el que sirve
      // para el seguimiento días después de la solicitud.
      case 'enviar_correo': {
        const email = normalizarEmail(cuerpo.email);
        const asunto = texto(cuerpo.asunto, 300);
        const mensaje = texto(cuerpo.texto, 20000);
        const folio = texto(cuerpo.folio, 40) || null;
        if (!email || !asunto || !mensaje) {
          return res.status(400).json({ ok: false, error: 'falta email, asunto o texto' });
        }

        // `enRespuestaA`: si ya hay un correo del cliente en el hilo, se cuelga
        // del último para que en su bandeja no aparezca como un correo suelto.
        let enRespuestaA = null;
        try {
          const { rows } = await bd.query(
            `SELECT message_id FROM correos
              WHERE email = $1 AND direccion = 'in' AND message_id IS NOT NULL
              ORDER BY id DESC LIMIT 1`,
            [email]
          );
          if (rows.length) enRespuestaA = rows[0].message_id;
        } catch (e) {
          // Enhebrar es una mejora, no un requisito: si falla, se manda suelto.
          console.error('crm: no se pudo buscar el hilo del correo', e.message);
        }

        const envio = await enviarCorreo({ para: email, asunto, texto: mensaje, enRespuestaA });
        if (!envio.ok) return res.status(200).json(envio);

        // A partir de acá el correo YA salió: mismo razonamiento que en
        // `enviar`. Un 500 haría que el asesor lo reenviara.
        try {
          await bd.query(
            `INSERT INTO correos (folio, email, direccion, asunto, texto, autor, message_id, en_respuesta_a)
                  VALUES ($1, $2, 'out', $3, $4, 'asesor', $5, $6)`,
            [folio, email, asunto, mensaje, envio.messageId || null, enRespuestaA]
          );
        } catch (e) {
          console.error('crm: correo enviado pero no registrado en la base', e);
          return res.status(200).json({
            ok: true,
            aviso: 'el correo salio, pero no se pudo guardar en el historial',
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
