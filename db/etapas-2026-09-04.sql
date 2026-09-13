-- Pipeline de ventas: agrega la columna `etapa` a `registros`.
--
-- La base de produccion ya existe (schema.sql se corrio el 2026-08-21), asi
-- que este archivo aparte se corre tal cual en el editor SQL de Supabase.
-- Es idempotente: se puede correr las veces que haga falta.
--
-- `etapa` es independiente de `atendido` a proposito: `atendido` sigue siendo
-- el "ya lo mire" del asesor, `etapa` es donde esta el lead en el embudo. No
-- se derivan una de la otra (ver `dos-fuentes-de-verdad` en la wiki).

ALTER TABLE registros ADD COLUMN IF NOT EXISTS etapa TEXT NOT NULL DEFAULT 'nuevo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_name = 'registros' AND constraint_name = 'registros_etapa_check'
  ) THEN
    ALTER TABLE registros
      ADD CONSTRAINT registros_etapa_check
      CHECK (etapa IN ('nuevo', 'contactado', 'cotizado', 'negociando', 'ganado', 'perdido'));
  END IF;
END $$;
