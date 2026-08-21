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
