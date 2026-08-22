// Envío de correo del CRM.
//
// El asesor ya podía escribir por WhatsApp desde el panel, pero ahí manda la
// ventana de 24 h de Meta: pasado ese rato solo salen plantillas preaprobadas.
// El correo no tiene esa limitación y es la dirección que el cliente dejó en el
// formulario, así que es el canal que sirve para el seguimiento.
//
// ── Por qué hay una capa de proveedor y no una llamada directa ───────────────
//
// La lección de `wiki/conceptos/sin-n8n.md` es reciente y cara: tres sistemas
// murieron a la vez porque dependían de un servicio alojado que se apagó sin
// avisar. Con el correo pasa lo mismo — hace falta *alguien* que lo entregue —
// pero el daño se acota si cambiar de proveedor es escribir una función acá y
// tocar dos variables de entorno, en vez de buscar llamadas repartidas por el
// código.
//
// Hoy está implementado Resend, que se eligió por tres razones concretas:
// habla HTTP (así que **no agrega ninguna dependencia npm**: el proyecto sigue
// con `pg` como única), verifica el dominio propio que la agencia ya tiene
// (mining-big.com), y tiene entrada de correo para las respuestas. Agregar
// otro es agregar una entrada a PROVEEDORES.
//
// Variables de entorno:
//   CORREO_API_KEY    la clave del proveedor. Sin ella, el CRM funciona
//                     entero menos el botón de correo, que dice por qué.
//   CORREO_REMITENTE  'Mining Big <gerencia@mining-big.com>'. El dominio tiene
//                     que estar verificado en el proveedor o los correos van a
//                     spam o directamente rebotan.
//   CORREO_PROVEEDOR  'resend' por defecto.
//   CORREO_RESPONDER_A opcional: a dónde llegan las respuestas, si es distinto
//                     del remitente.

const PROVEEDORES = {
  // Devuelve { ok, messageId } o { ok:false, error }.
  async resend({ para, asunto, texto, responderA, enRespuestaA, remitente, clave }) {
    const cuerpo = {
      from: remitente,
      to: [para],
      subject: asunto,
      text: texto,
    };
    if (responderA) cuerpo.reply_to = responderA;
    // Enhebrar: sin estas dos cabeceras, la respuesta del cliente le aparece
    // como un correo suelto en vez de colgando del hilo.
    if (enRespuestaA) {
      cuerpo.headers = {
        'In-Reply-To': enRespuestaA,
        References: enRespuestaA,
      };
    }

    const respuesta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clave}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });

    const json = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
      const detalle = (json && (json.message || json.name)) || `HTTP ${respuesta.status}`;
      return { ok: false, error: detalle };
    }
    return { ok: true, messageId: (json && json.id) || null };
  },
};

// Un correo válido de verdad no se puede validar con una expresión regular,
// pero esto descarta lo que claramente no lo es antes de gastar una llamada al
// proveedor. Es la misma que usa `api/registro.js`.
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizarEmail(valor) {
  return String(valor === null || valor === undefined ? '' : valor).trim().toLowerCase();
}

// Devuelve el motivo cuando el proveedor rechaza, igual que `lib/whatsapp.js`:
// el panel lo muestra tal cual. Decir "enviado" cuando no salió es peor que
// fallar.
async function enviarCorreo({ para, asunto, texto, enRespuestaA }) {
  const clave = process.env.CORREO_API_KEY;
  const remitente = process.env.CORREO_REMITENTE;
  const nombreProveedor = process.env.CORREO_PROVEEDOR || 'resend';

  if (!clave || !remitente) {
    return { ok: false, error: 'el correo no esta configurado en el servidor' };
  }
  const proveedor = PROVEEDORES[nombreProveedor];
  if (!proveedor) {
    console.error(`correo: proveedor desconocido '${nombreProveedor}'`);
    return { ok: false, error: `proveedor de correo desconocido: ${nombreProveedor}` };
  }

  const destino = normalizarEmail(para);
  if (!EMAIL_VALIDO.test(destino)) {
    return { ok: false, error: 'la direccion de correo no es valida' };
  }
  if (!String(asunto || '').trim()) {
    return { ok: false, error: 'el asunto no puede ir vacio' };
  }
  if (!String(texto || '').trim()) {
    return { ok: false, error: 'el cuerpo no puede ir vacio' };
  }

  try {
    const r = await proveedor({
      para: destino,
      asunto: String(asunto).trim(),
      texto: String(texto),
      responderA: process.env.CORREO_RESPONDER_A || undefined,
      enRespuestaA: enRespuestaA || undefined,
      remitente,
      clave,
    });
    if (!r.ok) console.error('correo: el proveedor rechazó el envío:', r.error);
    return r;
  } catch (e) {
    console.error('correo: no se pudo hablar con el proveedor', e);
    return { ok: false, error: 'no se pudo contactar al proveedor de correo' };
  }
}

module.exports = { enviarCorreo, normalizarEmail, EMAIL_VALIDO };
