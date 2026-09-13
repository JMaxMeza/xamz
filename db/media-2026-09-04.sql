-- Adjuntos en el chat de WhatsApp: columnas nuevas en `mensajes` + el bucket
-- de Storage donde se guardan los archivos.
--
-- La base de produccion ya existe, asi que este archivo aparte se corre tal
-- cual en el editor SQL de Supabase. Es idempotente.
--
-- Contexto: hasta hoy el bot (`api/bot.js`) descartaba en silencio cualquier
-- mensaje que no fuera texto -- una foto del terreno o del equipo, algo nada
-- raro en un negocio de alquiler de maquinaria, se perdia sin dejar rastro.

-- 1. Las dos columnas nuevas en `mensajes`. `media_url` guarda el link
--    PUBLICO del bucket (no el link temporal que da Meta, que vence en
--    minutos); `media_tipo` guarda el `type` del webhook de Meta ('image'
--    por ahora). Las dos NULL en un mensaje sin adjunto -- casi todos.
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS media_tipo TEXT;

-- 2. El bucket. Publico a proposito: evita tener que firmar URLs para que el
--    panel pueda mostrar una miniatura, y el riesgo real es bajo -- la ruta
--    de cada archivo lleva el wa_id o un uuid, no es adivinable en la
--    practica. Mismo criterio de "seguridad por URL larga" que ya usan los
--    links de media temporales de Meta.
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', true)
ON CONFLICT (id) DO NOTHING;
