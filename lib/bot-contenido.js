// Contenido del bot de FAQ de Mining Big: los textos, las palabras clave y las
// preguntas del cuestionario.
//
// ─────────────────────────────────────────────────────────────────────────────
// ESTE ARCHIVO ESTÁ HECHO PARA EDITARSE SIN SABER PROGRAMAR.
// Son textos entre comillas y listas de palabras. La lógica está en
// `api/bot.js` y no hace falta tocarla para cambiar lo que el bot dice.
// ─────────────────────────────────────────────────────────────────────────────
//
// El contenido sale de la landing (`index.html`). Si cambia la flota o las
// condiciones ahí, hay que actualizarlo también acá — son dos lugares a mano,
// no hay sincronización automática.

// Teléfono del asesor, en dígitos y con código de país. Es a donde apunta el
// enlace `wa.me` que recibe el cliente cuando pide hablar con una persona.
//
// Se puede pisar con la variable de entorno `ASESOR_WHATSAPP` sin tocar el
// código ni redesplegar el repo — para el día que cambie el número, o para
// derivar a otra persona por un tiempo. El valor de acá es el que rige si la
// variable no está.
const ASESOR = process.env.ASESOR_WHATSAPP || '51934747464';

// ── El menú ──────────────────────────────────────────────────────────────────
// Se manda al saludar, y también cuando el bot no entiende: el bot nunca deja
// al usuario sin salida.
const MENU = `*Mining Big* — alquiler de maquinaria pesada.

Responde con un número:

*1* · Flota disponible
*2* · Cómo alquilar
*3* · Qué incluye el servicio
*4* · Tarifas
*5* · Hablar con un asesor`;

const NO_ENTENDI = `No entendí eso. Te dejo el menú de nuevo:

${MENU}`;

// ── Las respuestas del modo FAQ ──────────────────────────────────────────────
const RESPUESTAS = {
  flota: `*Flota 2026* — 128 unidades operativas, mantenimiento al día.

• Excavadora de orugas · clase 36 t · 1.9 m³ · 268 hp
• Volquete 15 m³ · roquero 8×4 · 25 t · 420 hp
• Cargador frontal · articulado · 3.4 m³ · 300 hp
• Tractor de orugas · hoja SU · 8.7 m³ · 354 hp
• Motoniveladora · 12 pies · 3.7 m de hoja · 193 hp
• Perforadora hidráulica · Ø 89–127 mm · 243 hp
• Rodillo compactador · liso vibratorio · 2.13 m · 130 hp
• Grúa telescópica · 60 t · 48 m de alcance

Trabajamos hasta 4 800 msnm y despachamos a obra en 24–72 h.

Responde *4* para tarifas o *2* para saber cómo alquilar.`,

  proceso: `*Cómo alquilar* — tres pasos.

*1. Te registras.* Dejas tus datos y el tipo de equipo. Toma menos de un minuto y no pedimos ningún pago para abrir la cuenta.

*2. Recibes cotización.* Un asesor revisa tu frente de trabajo y te envía tarifa por hora, día o mes, con disponibilidad real y fecha de despacho.

*3. Llega a tu frente.* Coordinamos traslado en cama baja, entrega con checklist firmado y operador certificado si lo necesitas.

Regístrate en https://mining-big.com y respóndenos las seis preguntas por acá: tu asesor llega con la tarifa ya calculada.`,

  incluye: `*Lo que va incluido.*

• *Mantenimiento* — preventivo programado por horómetro y correctivo en sitio, sin cargo adicional.
• *Operador certificado* — personal con acreditación vigente en seguridad minera, opcional por turno.
• *Traslado* — cama baja propia, permisos de ruta y descarga en el frente de trabajo.
• *Póliza y respaldo* — equipo asegurado y unidad de reemplazo si una máquina sale de servicio.

Responde *4* para tarifas o *5* para hablar con un asesor.`,

  tarifas: `*Tarifas.*

Las cotizamos caso por caso: dependen del equipo, del tiempo de alquiler, de la altitud y del acceso a tu frente de trabajo. Por eso no manejamos una lista de precios fija — te daríamos un número que no sirve.

Hay tarifa por *hora, día, mes o proyecto completo*.

Para que un asesor te llegue con el precio ya calculado, regístrate en https://mining-big.com y respóndenos seis preguntas rápidas por acá. Respondemos dentro de las 24 horas hábiles.

Si prefieres hablar directamente, responde *5*.`,

  asesor: `Te paso con un asesor.

Escríbele directo acá: https://wa.me/${ASESOR}

Atendemos de lunes a sábado, 07:00 – 19:00. Si escribes fuera de ese horario te responde al abrir.`,
};

// ── Enrutamiento del modo FAQ ────────────────────────────────────────────────
//
// ⚠️ EL ORDEN IMPORTA: gana la PRIMERA rama que coincide.
//
// *Tarifas va antes que Flota a propósito.* Con el orden inverso, "cuanto
// cuesta un volquete" caía en Flota (coincidía "volquete" primero) y el cliente
// recibía un catálogo en vez de una respuesta de precio. En un negocio cuyo
// embudo entero apunta a la cotización, la intención de precio tiene que ganar.
//
// `numeros` se compara con el mensaje ENTERO (exacto). `claves` se busca como
// parte del texto. Las dos comparaciones se hacen sin tildes y en minúsculas,
// así que acá se escriben sin tildes: "maquina" también atrapa "máquina".
const RAMAS = [
  {
    nombre: 'tarifas',
    numeros: ['4'],
    claves: ['tarifa', 'precio', 'costo', 'cuesta', 'vale', 'cotiza', 'presupuesto', 'cuanto'],
  },
  {
    nombre: 'asesor',
    numeros: ['5'],
    claves: ['asesor', 'humano', 'persona', 'vendedor', 'contacto', 'llamar', 'telefono', 'hablar con'],
  },
  {
    nombre: 'incluye',
    numeros: ['3'],
    claves: ['incluye', 'incluido', 'operador', 'traslado', 'flete', 'mantenimiento', 'poliza', 'seguro', 'garantia'],
  },
  {
    nombre: 'proceso',
    numeros: ['2'],
    claves: ['como alquil', 'como rent', 'proceso', 'paso', 'registr', 'alquilar', 'rentar', 'reservar'],
  },
  {
    nombre: 'flota',
    numeros: ['1'],
    claves: [
      'flota', 'equipo', 'maquina', 'catalogo', 'disponible',
      // Los 8 nombres de la flota. Sin estos, "necesito una grua" caía en el
      // fallback: fue un bug real que encontraron las pruebas del 2026-08-02.
      'excavadora', 'volquete', 'cargador', 'tractor',
      'motoniveladora', 'perforadora', 'rodillo', 'grua',
    ],
  },
  {
    nombre: 'menu',
    numeros: ['0'],
    claves: ['hola', 'menu', 'inicio', 'buenas', 'empezar', 'ayuda', 'opciones'],
  },
];

// ── El cuestionario de calificación ──────────────────────────────────────────
//
// Agregar, sacar o reordenar preguntas es editar ESTE array y nada más: el
// motor recorre lo que haya. `columna` es dónde se guarda la respuesta en la
// tabla `conversaciones`; si se agrega una pregunta nueva hay que agregar
// también esa columna en `db/schema-crm.sql`.
//
// Todas son de opción múltiple numerada a propósito: el objetivo es *dato
// exacto* para que el asesor cotice, no texto libre que después haya que
// interpretar.
const PREGUNTAS = [
  {
    columna: 'unidades',
    titulo: '¿Cuántas unidades necesitas?',
    opciones: ['Una', 'Dos o tres', 'De cuatro a seis', 'Más de seis'],
  },
  {
    columna: 'cuando',
    titulo: '¿Para cuándo la necesitas?',
    opciones: ['Esta semana', 'En 2 a 4 semanas', 'En 1 a 3 meses', 'Todavía estoy cotizando'],
  },
  {
    columna: 'duracion',
    titulo: '¿Por cuánto tiempo?',
    opciones: ['Por días', 'Por semanas', 'Por meses', 'Proyecto completo'],
  },
  {
    columna: 'operador',
    titulo: '¿Necesitas operador certificado?',
    opciones: ['Sí, para todos los turnos', 'Sí, solo algunos turnos', 'No, tengo operadores', 'Todavía no lo defino'],
  },
  {
    columna: 'acceso',
    titulo: '¿El frente tiene acceso para cama baja?',
    opciones: ['Sí, acceso directo', 'Parcial, el último tramo es complicado', 'No, hay que evaluarlo', 'No lo sé'],
  },
  {
    columna: 'altitud',
    titulo: '¿A qué altitud va a trabajar el equipo?',
    opciones: ['Bajo 2 500 msnm', 'Entre 2 500 y 3 500', 'Entre 3 500 y 4 500', 'Sobre 4 500 msnm'],
  },
];

// Textos del cuestionario.
const CUESTIONARIO = {
  // Se manda al reconocer el folio en el primer mensaje.
  bienvenida: (folio) =>
    `¡Gracias por registrarte! Tu folio es *${folio}*.

Te hago *seis preguntas rápidas* para que tu asesor llegue con la tarifa ya calculada. Son todas de opción múltiple.

En cualquier momento: *0* para terminar · *9* para hablar con un asesor.`,

  fueraDeRango: 'Esa opción no está en la lista. Responde con el número de una de las opciones:',

  cerrada: `Listo, dejamos hasta acá. Tu solicitud ya está registrada y un asesor te escribe dentro de las 24 horas hábiles.

Si necesitas algo, escribe *hola* y te muestro el menú.`,

  // Resumen que ve el cliente al terminar las 6.
  completa: (resumen) => `¡Listo! Esto es lo que anoté:

${resumen}

Un asesor de Mining Big te escribe dentro de las *24 horas hábiles* con la tarifa y la disponibilidad para tu frente.

Si quieres adelantarlo, escríbele directo: https://wa.me/${ASESOR}`,

  // Derivación al asesor (opción 9). No se le puede avisar al asesor por
  // WhatsApp sin plantilla aprobada, así que en vez de eso se le da al cliente
  // el enlace directo junto con el resumen de lo que ya respondió. El cliente
  // decide si escribe o espera.
  derivada: (resumen) => `Te paso con un asesor.

Escríbele directo acá: https://wa.me/${ASESOR}

${resumen ? `Le adelanto lo que me contaste:\n\n${resumen}\n\n` : ''}También queda registrado de nuestro lado, así que si prefieres esperar, te escriben ellos.`,
};

module.exports = { ASESOR, MENU, NO_ENTENDI, RESPUESTAS, RAMAS, PREGUNTAS, CUESTIONARIO };
