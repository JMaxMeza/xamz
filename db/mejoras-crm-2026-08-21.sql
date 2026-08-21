-- Cambios de base que salieron de la revision del CRM del 2026-08-21.
--
-- La base de produccion ya tiene las tablas creadas (`schema.sql` y
-- `schema-crm.sql` se corrieron el 2026-08-21), asi que volver a correr esos
-- archivos no aplicaria lo nuevo... salvo por el `IF NOT EXISTS`, que si lo
-- hace. Este archivo esta aparte para no tener que releer los otros dos y
-- para poder correrlo tal cual en el editor SQL de Supabase.
--
-- Es idempotente: se puede correr las veces que haga falta.
-- Ninguna de estas sentencias bloquea escrituras de forma apreciable con el
-- volumen actual (decenas de filas).

-- 1. Indice que faltaba para la consulta que el panel hace mas veces.
--    `api/crm.js` lee, en cada sondeo (45 s con el panel abierto):
--      SELECT ... FROM conversaciones ORDER BY actualizado_en DESC
--    Sin indice, cada sondeo recorre la tabla entera y despues ordena.
CREATE INDEX IF NOT EXISTS conversaciones_actualizado_idx
  ON conversaciones (actualizado_en DESC);

-- 2. Comprobacion de que los datos cumplen lo que el codigo da por sentado:
--    el telefono se guarda en DIGITOS PUROS, sin '+' ni espacios. Si esta
--    consulta devuelve filas, hay datos que el panel no va a emparejar bien
--    (y el `toggle_bot` del CRM podria crear una fila paralela).
--    No se pone como CHECK a proposito: si el bot alguna vez escribe con '+',
--    un CHECK haria que se PIERDA el mensaje en vez de guardarlo torcido.
SELECT 'conversaciones' AS tabla, telefono FROM conversaciones WHERE telefono !~ '^[0-9]+$'
UNION ALL
SELECT 'mensajes', telefono FROM mensajes WHERE telefono !~ '^[0-9]+$'
UNION ALL
SELECT 'alertas', telefono FROM alertas WHERE telefono !~ '^[0-9]+$';

-- 3. Opcional, para decidir: `registros` no tiene indice por telefono y ya
--    hay duplicados reales (dos solicitudes comparten correo y celular con
--    nombre distinto). Con este indice se pueden buscar repetidos sin
--    recorrer la tabla. No cambia el comportamiento de nada.
-- CREATE INDEX IF NOT EXISTS registros_telefono_idx ON registros (telefono);
