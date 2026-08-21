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
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El panel abre siempre un hilo entero, en orden.
CREATE INDEX IF NOT EXISTS mensajes_hilo_idx ON mensajes (telefono, id);

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
