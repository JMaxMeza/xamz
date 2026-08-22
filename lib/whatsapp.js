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
async function enviarWhatsApp(telefono, cuerpo, opciones) {
  const token = process.env.WHATSAPP_TOKEN;
  const idNumero = (opciones && opciones.idNumero) || process.env.WHATSAPP_PHONE_ID;
  if (!token || !idNumero) {
    return { ok: false, error: 'WhatsApp no configurado en el servidor' };
  }

  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${idNumero}/messages`;
  const quien = (opciones && opciones.quien) || 'whatsapp';

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
    console.error(`${quien}: no se pudo hablar con la API de WhatsApp`, e);
    return { ok: false, error: 'no se pudo contactar a WhatsApp' };
  }

  const json = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    const detalle =
      (json && json.error && (json.error.error_user_msg || json.error.message)) ||
      `HTTP ${respuesta.status}`;
    console.error(`${quien}: WhatsApp rechazó el envío:`, detalle);
    return { ok: false, error: detalle };
  }
  return { ok: true };
}

module.exports = { enviarWhatsApp };
