-- Tablas del CRM. Reemplazan a las data tables de n8n
-- `conversaciones_mining_big`, `mensajes_mining_big` y `alertas_mining_big`.
--
-- Correr DESPUÉS de `schema.sql`, que crea `registros` (la cuarta colección
-- que lee el panel). Es Postgres estándar y es idempotente.
--
-- El teléfono se guarda como SOLO DÍGITOS, sin '+' ni espacios: el formulario
-- manda '+51 999 888 777' y WhatsApp manda '51999888777'. El panel empareja
-- por los últimos 9 dígitos, así que normalizar al escribir es lo que hace
-- que solicitud y chat se encuentren.

-- El estado del cuestionario de WhatsApp, una fila por teléfono.
CREATE TABLE IF NOT EXISTS conversaciones (
  telefono      TEXT        PRIMARY KEY,
  folio         TEXT,
  estado        TEXT        NOT NULL DEFAULT '',
  unidades      TEXT,
  cuando        TEXT,
  duracion      TEXT,
  operador      TEXT,
  acceso        TEXT,
  altitud       TEXT,
  -- NULL a propósito, no `DEFAULT true`: el bot crea la fila cuando llega el
  -- primer mensaje y no siempre sabe todavía el estado del interruptor.
  -- NULL y true significan encendido; solo false apaga. Es el mismo criterio
  -- que tenía la data table de n8n, y el panel ya lo lee así
  -- (`bot_activo === false`), de modo que no hay que tocar el front.
  bot_activo    BOOLEAN,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada mensaje del hilo, entrante o saliente.
CREATE TABLE IF NOT EXISTS mensajes (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telefono   TEXT        NOT NULL,
  direccion  TEXT        NOT NULL CHECK (direccion IN ('in', 'out')),
  texto      TEXT        NOT NULL DEFAULT '',
  -- 'cliente' | 'bot' | 'asesor'. El panel pinta las burbujas con esto:
  -- sin el autor no se distingue lo que contestó el bot de lo que escribió
  -- una persona, que es justo lo que el asesor necesita ver.
  autor      TEXT        NOT NULL DEFAULT 'cliente'
               CHECK (autor IN ('cliente', 'bot', 'asesor')),
  -- El id que Meta le pone al mensaje entrante (`messages[0].id`). Es lo que
  -- hace que el bot no conteste dos veces: Meta reintenta el webhook si no
  -- recibe el 200 a tiempo, y sin esto el mismo mensaje se procesaba de nuevo.
  -- NULL en los salientes, que no vienen de un webhook.
  wa_id      TEXT,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El panel abre siempre un hilo entero, en orden.
CREATE INDEX IF NOT EXISTS mensajes_hilo_idx ON mensajes (telefono, id);

-- Único PARCIAL, no un UNIQUE a secas: los salientes tienen `wa_id` NULL y en
-- Postgres los NULL no chocan entre sí, pero dejarlo parcial lo hace explícito
-- y mantiene el índice del tamaño de los entrantes nada más. Es el índice que
-- `ON CONFLICT (wa_id) WHERE wa_id IS NOT NULL` necesita para inferirse.
CREATE UNIQUE INDEX IF NOT EXISTS mensajes_wa_id_idx
  ON mensajes (wa_id) WHERE wa_id IS NOT NULL;

-- La accion `datos` del CRM lee la lista de conversaciones ordenada por
-- `actualizado_en` en cada sondeo (cada 45 s con el panel abierto). Sin este
-- indice, cada sondeo es un recorrido de la tabla entera mas un sort.
CREATE INDEX IF NOT EXISTS conversaciones_actualizado_idx
  ON conversaciones (actualizado_en DESC);

-- Cada vez que un cliente pide hablar con un asesor.
CREATE TABLE IF NOT EXISTS alertas (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telefono   TEXT        NOT NULL,
  folio      TEXT,
  motivo     TEXT        NOT NULL DEFAULT '',
  atendida   BOOLEAN     NOT NULL DEFAULT false,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Las pendientes primero y las nuevas arriba, que es como las lista el panel.
CREATE INDEX IF NOT EXISTS alertas_pendientes_idx
  ON alertas (atendida, id DESC);

-- El hilo de correo con cada cliente. WhatsApp tiene la ventana de 24 h de
-- Meta; el correo no, así que es el canal del seguimiento. Detalle de cada
-- columna en `db/correos-2026-08-21.sql`, que es el mismo DDL para correrlo
-- suelto en una base ya creada.
CREATE TABLE IF NOT EXISTS correos (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folio       TEXT,
  email       TEXT        NOT NULL,
  direccion   TEXT        NOT NULL CHECK (direccion IN ('in', 'out')),
  asunto      TEXT        NOT NULL DEFAULT '',
  texto       TEXT        NOT NULL DEFAULT '',
  autor       TEXT        NOT NULL DEFAULT 'asesor'
                CHECK (autor IN ('cliente', 'asesor', 'sistema')),
  message_id  TEXT,
  en_respuesta_a TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS correos_hilo_idx ON correos (email, id);
-- Anti-duplicado del webhook de correo entrante, igual que `wa_id` con Meta.
CREATE UNIQUE INDEX IF NOT EXISTS correos_message_id_idx
  ON correos (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS correos_folio_idx ON correos (folio) WHERE folio IS NOT NULL;
