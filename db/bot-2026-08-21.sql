-- Lo que la base YA CREADA necesita para el bot reconstruido (`api/bot.js`).
--
-- `schema-crm.sql` y `todo-en-uno.sql` ya traen esto para una base nueva, pero
-- la de producción se creó el 2026-08-21 sin la columna. Este archivo es para
-- correrlo tal cual en el editor SQL de Supabase.
--
-- Es idempotente: se puede correr las veces que haga falta.
-- Con el volumen actual (decenas de filas) no bloquea nada apreciable.

-- 1. El id que Meta le pone a cada mensaje entrante.
--
--    Sin esto el bot contesta de más: Meta reintenta el webhook cuando no
--    recibe el 200 a tiempo, y en producción se midieron hasta 4 entregas por
--    mensaje del usuario. El anti-duplicado es la base, no la memoria de la
--    función: en serverless no hay memoria compartida entre instancias.
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS wa_id TEXT;

-- 2. El índice que hace de anti-duplicado.
--
--    PARCIAL a propósito: los mensajes salientes no vienen de un webhook y
--    llevan `wa_id` NULL. Es además el índice que Postgres necesita para poder
--    inferir el `ON CONFLICT (wa_id) WHERE wa_id IS NOT NULL` que usa el bot;
--    con un UNIQUE a secas, ese INSERT falla con "no unique or exclusion
--    constraint matching the ON CONFLICT specification".
CREATE UNIQUE INDEX IF NOT EXISTS mensajes_wa_id_idx
  ON mensajes (wa_id) WHERE wa_id IS NOT NULL;

-- 3. Comprobación. Debería devolver una fila con la columna y el índice.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'mensajes' AND column_name = 'wa_id')   AS columna_wa_id,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'mensajes' AND indexname = 'mensajes_wa_id_idx') AS indice_wa_id;
