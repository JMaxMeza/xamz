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
