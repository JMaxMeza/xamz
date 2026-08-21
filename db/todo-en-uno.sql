-- ===================================================================
-- Mining Big — TODO EN UNO. Pegar entero en el SQL Editor de Supabase
-- y pulsar Run. Una sola vez.
--
-- Es la union de, en este orden:
--   1. schema.sql              -> tabla `registros`
--   2. schema-crm.sql          -> `conversaciones`, `mensajes`, `alertas`
--   3. migracion-registros.sql -> los 3 registros reales rescatados de n8n
--
-- Se puede correr dos veces sin romper nada: las tablas usan
-- IF NOT EXISTS y los INSERT usan ON CONFLICT DO NOTHING.
--
-- Generado el 2026-08-21. Si cambia alguno de los 3 archivos, este
-- deja de estar al dia: los originales mandan.
-- ===================================================================


-- ========== 1 de 3: schema.sql ==========

-- Esquema de la base de Mining Big.
-- Reemplaza a las data tables de n8n. Correr una vez en el editor SQL del
-- proveedor (Neon, Supabase, el que sea): es Postgres estándar, no usa
-- nada específico de ninguno.

CREATE TABLE IF NOT EXISTS registros (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folio       TEXT        NOT NULL UNIQUE,
  nombre      TEXT        NOT NULL,
  empresa     TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  telefono    TEXT        NOT NULL,
  zona        TEXT        NOT NULL DEFAULT '',
  plazo       TEXT        NOT NULL DEFAULT '',
  equipos     TEXT        NOT NULL DEFAULT '',
  detalle     TEXT        NOT NULL DEFAULT '',
  origen      TEXT        NOT NULL DEFAULT 'landing',
  atendido    BOOLEAN     NOT NULL DEFAULT false,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `folio` es UNIQUE a propósito. En n8n no lo era, y el folio son 4 dígitos
-- al azar dentro del mismo día: con ~40 registros diarios la probabilidad de
-- que dos coincidan pasa del 15%. Nadie lo habría notado hasta que dos
-- clientes distintos aparecieran con el mismo folio. La función reintenta
-- cuando choca.

-- El panel del CRM lista los pendientes primero, ordenados por fecha.
CREATE INDEX IF NOT EXISTS registros_pendientes_idx
  ON registros (atendido, creado_en DESC);

-- ========== 2 de 3: schema-crm.sql ==========

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

-- ========== 3 de 3: migracion-registros.sql ==========

-- Migracion de los registros que quedaron en las data tables de n8n.
-- Correr DESPUES de schema.sql, en el editor SQL del proveedor.
-- Es idempotente (ON CONFLICT DO NOTHING): se puede repetir sin duplicar.

-- ---------------------------------------------------------------
-- Registros reales: 3.
-- ---------------------------------------------------------------

-- n8n id 7
INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
  plazo, equipos, detalle, origen, atendido, creado_en)
VALUES ('MB-260803-7500', 'Yan Meza', '2MMicon', 'josefmax2008@gmail.com', '908900830', 'Norte', 'Por meses', 'Excavadora', '', 'landing', false, '2026-08-03T08:05:32.698Z')
ON CONFLICT (folio) DO NOTHING;

-- n8n id 8
INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
  plazo, equipos, detalle, origen, atendido, creado_en)
VALUES ('MB-260803-9377', 'Juan Torres', 'servitrans', 'servi@gmail.com', '904805521', 'Norte', 'Por semanas', 'Excavadora', 'para un proyecto en san gabriel', 'landing', false, '2026-08-04T04:03:07.584Z')
ON CONFLICT (folio) DO NOTHING;

-- n8n id 9
INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
  plazo, equipos, detalle, origen, atendido, creado_en)
VALUES ('MB-260804-8408', 'axel caver', '2Micon', 'servi@gmail.com', '904805521', 'Norte', 'Por meses', 'Excavadora', '', 'landing', false, '2026-08-04T05:21:46.494Z')
ON CONFLICT (folio) DO NOTHING;

-- ---------------------------------------------------------------
-- Registros de prueba: 6. Estan COMENTADOS a proposito.
-- Todos se llaman 'PRUEBA ... borrar', o sea que ya estaban
-- marcados para eliminar. Descomentar solo si se quiere el
-- historial completo de como se probo el sistema en agosto.
-- ---------------------------------------------------------------

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260802-9116', 'PRUEBA - borrar', 'Constructora Test SA', 'test@ejemplo.com', '+51 999 888 777', 'Sur', 'Por meses', 'Excavadora de orugas, Volquete 15 m3', 'Frente de trabajo a 4200 msnm', 'landing', false, '2026-08-03T04:15:23.117Z')
-- ON CONFLICT (folio) DO NOTHING;

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260802-4703', 'PRUEBA endpoint - borrar', 'Test SRL', 'endpoint@test.com', '+51 900 000 000', 'Norte', 'Por dias', 'Motoniveladora', 'prueba de endpoint publicado', 'landing', false, '2026-08-03T04:16:03.381Z')
-- ON CONFLICT (folio) DO NOTHING;

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260802-9975', 'PRUEBA navegador - borrar', 'Test Browser SA', 'browser@test.com', '+51 911 111 111', 'Norte', 'Por días', 'Excavadora, Cargador', 'enviado desde el navegador', 'landing', false, '2026-08-03T04:17:25.315Z')
-- ON CONFLICT (folio) DO NOTHING;

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260802-9670', 'PRUEBA aviso - borrar', 'Constructora Test SA', 'test@ejemplo.com', '+51 999 888 777', 'Sur', 'Por meses', 'Excavadora de orugas, Volquete 15 m3', 'Frente de trabajo a 4200 msnm', 'landing', false, '2026-08-03T04:23:48.473Z')
-- ON CONFLICT (folio) DO NOTHING;

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260802-6385', 'PRUEBA post-avisos - borrar', 'Test Final SRL', 'final@test.com', '+51 900 111 222', 'Centro', 'Proyecto completo', 'Grua telescopica', 'verificacion tras publicar avisos', 'landing', false, '2026-08-03T04:24:33.522Z')
-- ON CONFLICT (folio) DO NOTHING;

-- INSERT INTO registros (folio, nombre, empresa, email, telefono, zona,
--   plazo, equipos, detalle, origen, atendido, creado_en)
-- VALUES ('MB-260803-3012', 'PRUEBA boton wa - borrar', 'Test WA SA', 'wa@test.com', '+51 933 222 111', 'Centro', 'Por meses', 'Perforadora', 'prueba del boton de whatsapp', 'landing', false, '2026-08-03T07:54:18.057Z')
-- ON CONFLICT (folio) DO NOTHING;

-- Comprobacion: deberia devolver 3 (o 9 si descomentaste las pruebas).
SELECT count(*) AS registros_migrados FROM registros;
