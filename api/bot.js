// Bot de FAQ de WhatsApp de Mining Big.
//
// Reconstruye el workflow de n8n `QUnvDABERd9tfckF`, que murió con el
// workspace y no se pudo ni leer para portarlo. Se rehízo desde la
// especificación en `wiki/sistemas/bot-faq-whatsapp-mining-big.md`, que es lo
// único que quedó. Rige `wiki/conceptos/sin-n8n.md`: nada de la agencia vuelve
// a depender de un orquestador alojado.
//
//   GET  /api/bot   verificación del webhook de Meta -> devuelve hub.challenge
//   POST /api/bot   los mensajes
//
// Tiene dos modos, como el original:
//
//   FAQ           menú guiado, sin LLM. Coste cero por mensaje y respuestas
//                 100 % predecibles — en un negocio donde la tarifa se cotiza
//                 caso por caso, un modelo podría inventar precios.
//   Cuestionario  seis preguntas de calificación, que arrancan cuando el
//                 cliente llega desde la landing con su folio en el texto.
//
// Y alimenta al CRM: registra cada mensaje, obedece el interruptor
// `bot_activo` por conversación, y crea una alerta cuando el cliente pide
// hablar con una persona.
//
// Los textos, las palabras clave y las preguntas están en
// `lib/bot-contenido.js`, aparte a propósito: cambiar lo que el bot dice no
// debería obligar a tocar lógica.

const crypto = require('crypto');
const { obtenerPool, cadenaConexion, soloDigitos } = require('../lib/db');
const { enviarWhatsApp } = require('../lib/whatsapp');
const { CONFIG_SIN_PARSEO, cuerpoCrudo, consulta } = require('../lib/peticion');
const {
  MENU, NO_ENTENDI, RESPUESTAS, RAMAS, PREGUNTAS, CUESTIONARIO,
} = require('../lib/bot-contenido');

// Se pide el cuerpo sin parsear porque la firma de Meta se calcula sobre los
// bytes exactos. El detalle está en `lib/peticion.js`.
module.exports.config = CONFIG_SIN_PARSEO;

// ── Normalización ────────────────────────────────────────────────────────────

// Minúsculas, sin tildes y sin espacios de más. Las palabras clave de
// `bot-contenido.js` están escritas sin tildes, así que "máquina" y "maquina"
// caen en la misma rama — el cliente escribe como escribe.
function normalizar(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// El folio que la landing mete en el texto del enlace `wa.me`:
// "Hola, acabo de registrarme. Folio MB-260803-7500".
const FOLIO = /\bMB-\d{6}-\d{4}\b/i;

function buscarFolio(texto) {
  const m = String(texto || '').match(FOLIO);
  return m ? m[0].toUpperCase() : '';
}

// ── El motor de conversación ─────────────────────────────────────────────────
//
// Función pura: recibe el mensaje y la fila de conversación, devuelve qué
// responder y qué guardar. No toca la base ni la red, para poder probarla
// entera sin levantar nada.
//
// Estados de `conversaciones.estado`:
//   ''          modo FAQ (es el valor por defecto de la columna)
//   'p0'..'p5'  esperando la respuesta a PREGUNTAS[n]
//   'completa'  terminó el cuestionario -> vuelve a modo FAQ
//   'derivada'  pidió asesor -> vuelve a modo FAQ
//
// Devuelve: { modo, respuesta, estado, campos, alerta, motivoAlerta, folio }
function motor(entradaCruda, conversacion) {
  const entrada = normalizar(entradaCruda);
  const conv = conversacion || {};
  const estado = String(conv.estado || '');

  // 1. ¿Trae folio? Arranca (o rearranca) el cuestionario. Va primero a
  //    propósito: si alguien se registra de nuevo, la conversación se reinicia
  //    en vez de quedar atrapada en un estado viejo.
  const folio = buscarFolio(entradaCruda);
  if (folio) {
    return {
      modo: 'cuestionario',
      folio,
      estado: 'p0',
      campos: {},
      respuesta: `${CUESTIONARIO.bienvenida(folio)}\n\n${textoPregunta(0)}`,
      alerta: false,
    };
  }

  // 2. ¿Está en medio del cuestionario?
  const indice = indiceDePregunta(estado);
  if (indice !== -1) return enCuestionario(entrada, indice, conv);

  // 3. Modo FAQ.
  return enFaq(entrada, conv);
}

function indiceDePregunta(estado) {
  const m = /^p(\d+)$/.exec(estado);
  if (!m) return -1;
  const i = Number(m[1]);
  return i >= 0 && i < PREGUNTAS.length ? i : -1;
}

function textoPregunta(indice) {
  const p = PREGUNTAS[indice];
  const opciones = p.opciones.map((o, i) => `*${i + 1}* · ${o}`).join('\n');
  return `*${indice + 1}/${PREGUNTAS.length}* · ${p.titulo}\n\n${opciones}\n\n_0 para terminar · 9 para un asesor_`;
}

// Resumen de lo respondido, para el cierre y para la derivación al asesor.
function resumenDe(conv) {
  const lineas = [];
  for (const p of PREGUNTAS) {
    const valor = conv[p.columna];
    if (valor) lineas.push(`• ${p.titulo} *${valor}*`);
  }
  return lineas.join('\n');
}

function enCuestionario(entrada, indice, conv) {
  // 0 y 9 valen en cualquier pregunta, y por eso se miran antes que las
  // opciones: si una pregunta llegara a tener 9 opciones, la salida al asesor
  // sigue ganando.
  if (entrada === '0') {
    return {
      modo: 'cuestionario', estado: '', campos: {},
      respuesta: CUESTIONARIO.cerrada, alerta: false,
    };
  }
  if (entrada === '9') {
    return {
      modo: 'cuestionario', estado: 'derivada', campos: {},
      respuesta: CUESTIONARIO.derivada(resumenDe(conv)),
      alerta: true,
      motivoAlerta: `pidió asesor en la pregunta ${indice + 1} del cuestionario`,
    };
  }

  const pregunta = PREGUNTAS[indice];
  const elegida = /^\d+$/.test(entrada) ? Number(entrada) : 0;
  if (elegida < 1 || elegida > pregunta.opciones.length) {
    // Fuera de rango: se repite la pregunta en vez de avanzar con un dato
    // inventado. El asesor cotiza con esto.
    return {
      modo: 'cuestionario', estado: `p${indice}`, campos: {},
      respuesta: `${CUESTIONARIO.fueraDeRango}\n\n${textoPregunta(indice)}`,
      alerta: false,
    };
  }

  // Se guarda el TEXTO de la opción, no el número: en el panel del CRM el
  // asesor tiene que leer "Por meses", no "3".
  const campos = { [pregunta.columna]: pregunta.opciones[elegida - 1] };
  const siguiente = indice + 1;

  if (siguiente < PREGUNTAS.length) {
    return {
      modo: 'cuestionario', estado: `p${siguiente}`, campos,
      respuesta: textoPregunta(siguiente), alerta: false,
    };
  }

  // Terminó: el resumen tiene que incluir la respuesta que acaba de dar, que
  // todavía no está en `conv` porque se guarda después.
  const resumen = resumenDe({ ...conv, ...campos });
  return {
    modo: 'cuestionario', estado: 'completa', campos,
    respuesta: CUESTIONARIO.completa(resumen), alerta: false,
  };
}

function enFaq(entrada, conv) {
  // Gana la PRIMERA rama que coincide: el orden de RAMAS es una decisión de
  // producto, no un detalle. Ver el comentario en `lib/bot-contenido.js`.
  for (const rama of RAMAS) {
    const porNumero = rama.numeros.includes(entrada);
    const porClave = rama.claves.some((c) => entrada.includes(c));
    if (!porNumero && !porClave) continue;

    if (rama.nombre === 'menu') {
      return { modo: 'faq', rama: 'menu', respuesta: MENU, campos: {}, alerta: false };
    }
    return {
      modo: 'faq',
      rama: rama.nombre,
      respuesta: RESPUESTAS[rama.nombre],
      campos: {},
      alerta: rama.nombre === 'asesor',
      motivoAlerta: rama.nombre === 'asesor' ? 'pidió hablar con un asesor' : undefined,
      // Si ya había contestado el cuestionario, se le adjunta el resumen al
      // asesor igual que en la derivación desde el cuestionario.
      resumen: rama.nombre === 'asesor' ? resumenDe(conv) : undefined,
    };
  }

  // El fallback repite el menú a propósito: el bot nunca deja al usuario sin
  // salida.
  return { modo: 'faq', rama: 'no_entendi', respuesta: NO_ENTENDI, campos: {}, alerta: false };
}

// ── Persistencia ─────────────────────────────────────────────────────────────

// Los nombres de columna que el motor puede tocar. Un nombre de columna no se
// puede parametrizar en SQL, así que se interpola — y por eso se valida contra
// esta lista antes: lo que entra a la plantilla sale de acá, nunca del mensaje
// del cliente.
const COLUMNAS = new Set(PREGUNTAS.map((p) => p.columna));

async function guardarConversacion(bd, telefono, resultado, folioPrevio) {
  const columnas = ['telefono', 'estado', 'folio', 'actualizado_en'];
  const valores = [telefono, resultado.estado, resultado.folio || folioPrevio || null];
  const marcadores = ['$1', '$2', '$3', 'now()'];

  for (const [columna, valor] of Object.entries(resultado.campos || {})) {
    if (!COLUMNAS.has(columna)) {
      throw new Error(`columna no permitida en el motor: ${columna}`);
    }
    valores.push(valor);
    columnas.push(columna);
    marcadores.push(`$${valores.length}`);
  }

  // Todas menos `telefono`, que es la clave.
  const actualiza = columnas
    .slice(1)
    .map((c, i) => `${c} = ${marcadores[i + 1]}`)
    .join(', ');

  await bd.query(
    `INSERT INTO conversaciones (${columnas.join(', ')})
     VALUES (${marcadores.join(', ')})
     ON CONFLICT (telefono) DO UPDATE SET ${actualiza}`,
    valores
  );
}

// Un fallo del registro nunca puede callar al bot: se loguea y se sigue. Es la
// misma regla que tenía el workflow con `onError: continueRegularOutput`.
async function registrarMensaje(bd, fila) {
  try {
    const r = await bd.query(
      `INSERT INTO mensajes (telefono, direccion, texto, autor, wa_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
      [fila.telefono, fila.direccion, fila.texto, fila.autor, fila.wa_id || null]
    );
    return { ok: true, insertadas: r.rowCount };
  } catch (e) {
    console.error('bot: no se pudo registrar el mensaje:', e.message);
    // `null` y no 0: 0 significaría "duplicado" y esto es "no sé".
    return { ok: false, insertadas: null };
  }
}

// ── Firma de Meta ────────────────────────────────────────────────────────────

// Devuelve { ok, motivo }. `ok:true` con `motivo` significa que se dejó pasar
// sin comprobar, que es distinto de haber comprobado bien.
function firmaValida(crudo, cabecera) {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto) return { ok: true, motivo: 'sin WHATSAPP_APP_SECRET: firma NO comprobada' };
  if (!crudo) return { ok: true, motivo: 'cuerpo ya parseado: firma NO comprobada' };
  if (!cabecera) return { ok: false, motivo: 'falta X-Hub-Signature-256' };

  const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(crudo).digest('hex');
  const a = Buffer.from(String(cabecera));
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return { ok: false, motivo: 'firma con largo distinto' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, motivo: 'firma no coincide' };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Verificación del webhook: Meta pega un GET una sola vez, al configurarlo.
  if (req.method === 'GET') {
    const q = consulta(req);
    const esperado = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!esperado) {
      console.error('bot: falta la variable de entorno WHATSAPP_VERIFY_TOKEN');
      return res.status(500).send('bot no configurado');
    }
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === esperado) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(String(q['hub.challenge'] || ''));
    }
    return res.status(403).send('token de verificacion incorrecto');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'metodo no permitido' });
  }

  const crudo = await cuerpoCrudo(req).catch(() => null);
  const firma = firmaValida(crudo, req.headers['x-hub-signature-256']);
  if (!firma.ok) {
    console.error('bot: POST rechazado —', firma.motivo);
    return res.status(401).json({ ok: false, error: 'firma invalida' });
  }
  if (firma.motivo) console.error('bot: ATENCION —', firma.motivo);

  let cuerpo = req.body;
  if (crudo) {
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'json invalido' });
    }
  }

  // Meta manda por el MISMO campo `messages` los mensajes entrantes y los
  // cambios de estado (enviado / entregado / leído). El encadenado opcional no
  // es cosmético: sin él, la lectura explota en los eventos de estado, que no
  // traen `messages`.
  const valor = cuerpo?.entry?.[0]?.changes?.[0]?.value;
  const mensaje = valor?.messages?.[0];
  const texto = mensaje?.text?.body;

  if (!mensaje || mensaje.type !== 'text' || !texto) {
    // No es un mensaje de texto (estado, imagen, audio…). Se responde 200 para
    // que Meta no reintente: no hay nada que hacer y no es un error.
    return res.status(200).json({ ok: true, ignorado: 'no es un mensaje de texto' });
  }

  const telefono = soloDigitos(mensaje.from);
  const idNumero = valor?.metadata?.phone_number_id;

  if (!telefono) {
    return res.status(200).json({ ok: true, ignorado: 'mensaje sin remitente' });
  }
  if (!cadenaConexion()) {
    console.error('bot: falta DATABASE_URL (o POSTGRES_URL)');
    // 500 a propósito: es un fallo nuestro y conviene que Meta reintente.
    return res.status(500).json({ ok: false, error: 'base de datos no configurada' });
  }

  const bd = obtenerPool('bot');

  try {
    // Registrar el entrante ANTES que nada: aunque el bot esté apagado, aunque
    // la respuesta falle, el mensaje del cliente queda en el CRM. Y el
    // `ON CONFLICT (wa_id)` hace de anti-duplicado: Meta reintenta el webhook
    // si no recibe el 200 a tiempo, y sin esto el cliente recibía la misma
    // respuesta dos o tres veces.
    const registro = await registrarMensaje(bd, {
      telefono, direccion: 'in', texto, autor: 'cliente', wa_id: mensaje.id,
    });
    if (registro.insertadas === 0) {
      return res.status(200).json({ ok: true, ignorado: 'mensaje repetido' });
    }

    const { rows } = await bd.query(
      `SELECT telefono, folio, estado, unidades, cuando, duracion, operador,
              acceso, altitud, bot_activo
         FROM conversaciones WHERE telefono = $1`,
      [telefono]
    );
    const conversacion = rows[0] || null;

    // El interruptor del panel del CRM. `null` o vacío = encendido; solo
    // `false` apaga. El asesor tomó el chat: el bot registra lo que llega pero
    // no contesta.
    if (conversacion && conversacion.bot_activo === false) {
      return res.status(200).json({ ok: true, ignorado: 'bot apagado para esta conversacion' });
    }

    const resultado = motor(texto, conversacion);
    await guardarConversacion(bd, telefono, resultado, conversacion && conversacion.folio);

    const envio = await enviarWhatsApp(telefono, resultado.respuesta, {
      idNumero, quien: 'bot',
    });

    if (envio.ok) {
      await registrarMensaje(bd, {
        telefono, direccion: 'out', texto: resultado.respuesta, autor: 'bot',
      });
    }

    if (resultado.alerta) {
      try {
        await bd.query(
          `INSERT INTO alertas (telefono, folio, motivo) VALUES ($1, $2, $3)`,
          [
            telefono,
            resultado.folio || (conversacion && conversacion.folio) || null,
            resultado.motivoAlerta || 'pidió hablar con un asesor',
          ]
        );
      } catch (e) {
        // Que falle la alerta no puede deshacer una respuesta ya enviada.
        console.error('bot: no se pudo crear la alerta:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      modo: resultado.modo,
      rama: resultado.rama,
      enviado: envio.ok,
      error_envio: envio.ok ? undefined : envio.error,
    });
  } catch (e) {
    console.error('bot: fallo procesando el mensaje:', e);
    // 200 y no 500: el mensaje entrante ya quedó registrado, así que el
    // reintento de Meta lo descartaría igual por `wa_id` repetido. Devolver
    // 500 solo conseguiría que Meta reintente varias veces para nada.
    return res.status(200).json({ ok: false, error: 'fallo interno' });
  }
};

// Exportados para las pruebas: el motor es una función pura y se puede
// ejercitar entero sin base ni red.
module.exports.motor = motor;
module.exports.normalizar = normalizar;
module.exports.buscarFolio = buscarFolio;
module.exports.textoPregunta = textoPregunta;
module.exports.firmaValida = firmaValida;
