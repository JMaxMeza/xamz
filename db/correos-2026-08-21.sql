-- Correo del CRM: la tabla `correos`.
--
-- El asesor ya podía escribirle al cliente por WhatsApp desde el panel, pero
-- WhatsApp tiene la ventana de 24 h de Meta: pasado ese rato solo se puede
-- mandar una plantilla preaprobada. El correo no tiene esa limitación, y es el
-- canal que el cliente dejó en el formulario de la landing.
--
-- Correrlo en el editor SQL de Supabase. Es idempotente.

CREATE TABLE IF NOT EXISTS correos (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- El folio de `registros` cuando se sabe cuál es. Se guarda como texto y no
  -- como clave foránea a propósito: un correo entrante puede llegar de alguien
  -- que todavía no está en `registros`, y perder ese correo sería peor que
  -- tenerlo suelto.
  folio       TEXT,
  -- Siempre la dirección DEL CLIENTE, tanto en los que entran como en los que
  -- salen. Es lo que enhebra la conversación: el panel agrupa por esta columna.
  -- Se guarda en minúsculas y sin espacios (lo normaliza el código).
  email       TEXT        NOT NULL,
  direccion   TEXT        NOT NULL CHECK (direccion IN ('in', 'out')),
  asunto      TEXT        NOT NULL DEFAULT '',
  texto       TEXT        NOT NULL DEFAULT '',
  -- 'cliente' | 'asesor' | 'sistema'. Igual que en `mensajes`: sin el autor,
  -- el asesor no distingue lo que escribió él de lo que mandó el sistema.
  autor       TEXT        NOT NULL DEFAULT 'asesor'
                CHECK (autor IN ('cliente', 'asesor', 'sistema')),
  -- `Message-ID` del correo. En los salientes lo devuelve el proveedor; en los
  -- entrantes viene en la cabecera. Sirve para dos cosas: enhebrar, y hacer de
  -- anti-duplicado cuando el proveedor reintenta el webhook — el mismo
  -- problema que Meta con el bot.
  message_id  TEXT,
  -- `In-Reply-To` del correo entrante: a cuál de los nuestros contesta.
  en_respuesta_a TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El panel abre un hilo entero, en orden, igual que en Chats.
CREATE INDEX IF NOT EXISTS correos_hilo_idx ON correos (email, id);

-- Anti-duplicado. Parcial porque `message_id` puede faltar: hay proveedores
-- que no lo devuelven al enviar, y un entrante mal formado podría no traerlo.
-- Que falte no debe impedir guardar el correo.
CREATE UNIQUE INDEX IF NOT EXISTS correos_message_id_idx
  ON correos (message_id) WHERE message_id IS NOT NULL;

-- Para cruzar el hilo con la solicitud sin recorrer la tabla.
CREATE INDEX IF NOT EXISTS correos_folio_idx ON correos (folio) WHERE folio IS NOT NULL;

-- Comprobación: debería devolver 1, 3.
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_name = 'correos')                                    AS tabla,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'correos' AND indexname LIKE 'correos_%')      AS indices;
