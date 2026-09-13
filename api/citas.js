// API de citas y calificación de leads - XAMZ Bandeja Fase 2
//
// GET /api/citas -> {citas, nuevos_sin_contactar, resumen}
// POST /api/citas {accion, ...} -> maneja agendar cita o calificar lead

const { obtenerPool } = require('../lib/db');

async function getCitas(req, res) {
  try {
    const bd = obtenerPool();
    const userId = req.session?.userId || req.body?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    // Obtener citas pendientes del usuario
    const citas = await bd.query(`
      SELECT c.id, c.persona_id, c.tipo, c.fecha, c.hora,
             p.nombre, p.telefono, p.email, p.asesora_id,
             p.horario_disp_lunes, p.horario_disp_martes,
             p.capacidad_inversion_anual, p.proyecto_interes
        FROM citas c
        JOIN personas p ON c.persona_id = p.id
       WHERE c.asesora_id = $1 AND c.estado = 'pendiente'
       ORDER BY c.fecha ASC, c.hora ASC
    `, [userId]);

    // Obtener nuevos leads sin contactar del usuario
    const nuevosSinContactar = await bd.query(`
      SELECT p.id, p.nombre, p.telefono, p.email, p.horario_disp_lunes,
             p.horario_disp_martes, p.horario_disp_miercoles,
             p.capacidad_inversion_anual, p.proyecto_interes,
             COALESCE(p.ultimo_reingreso, p.fecha_alta) as prioridad
        FROM personas p
       WHERE p.asesora_id = $1
         AND p.estado = 'NUEVO'
         AND NOT EXISTS (SELECT 1 FROM interacciones i WHERE i.persona_id = p.id)
       ORDER BY prioridad DESC
       LIMIT 20
    `, [userId]);

    return res.status(200).json({
      citas: citas.rows,
      nuevos_sin_contactar: nuevosSinContactar.rows,
      resumen: { total_citas: citas.rows.length, nuevos: nuevosSinContactar.rows.length }
    });
  } catch (err) {
    console.error('[api/citas GET]', err);
    return res.status(500).json({ error: 'Error al obtener citas' });
  }
}

async function postCitas(req, res) {
  const { accion } = req.body;

  if (accion === 'calificar') {
    return calificarLead(req, res);
  }

  // Agendar cita (acción por defecto)
  return agendarCita(req, res);
}

async function calificarLead(req, res) {
  try {
    const {
      persona_id,
      contactado,
      respuesta_a, respuesta_b, respuesta_c, respuesta_d, respuesta_e,
      motivo_perdida, comentario_perdida
    } = req.body;

    const bd = obtenerPool();

    // Validar campos requeridos
    if (!persona_id || contactado === undefined) {
      return res.status(400).json({ error: 'Faltan persona_id o contactado' });
    }

    if (contactado === false) {
      // Solo marcar como contactado pero sin responder las preguntas
      await bd.query(
        'UPDATE personas SET actualizado_en = NOW() WHERE id = $1',
        [persona_id]
      );
      return res.status(200).json({ resultado: 'no_contactado' });
    }

    if (contactado === true && motivo_perdida) {
      // Marcar como PERDIDO con motivo
      if (motivo_perdida === 'OTRO' && !comentario_perdida?.trim()) {
        return res.status(400).json({ error: 'Comentario obligatorio cuando motivo es OTRO' });
      }

      await bd.query(
        `UPDATE personas
         SET estado = 'PERDIDO', motivo_perdida = $1, comentario_perdida = $2,
             actualizado_en = NOW()
         WHERE id = $3`,
        [motivo_perdida, comentario_perdida || null, persona_id]
      );
      return res.status(200).json({ resultado: 'perdido', motivo: motivo_perdida });
    }

    if (contactado === true) {
      // Guardar respuestas de calificación
      if (!respuesta_a || !respuesta_b || !respuesta_c) {
        return res.status(400).json({ error: 'Preguntas A, B y C son requeridas' });
      }

      await bd.query(
        `UPDATE personas
         SET estado = 'CONTACTADO',
             respuesta_pregunta_a = $1,
             respuesta_pregunta_b = $2,
             respuesta_pregunta_c = $3,
             respuesta_pregunta_d = $4,
             respuesta_pregunta_e = $5,
             fecha_calificacion = NOW(),
             actualizado_en = NOW()
         WHERE id = $6`,
        [respuesta_a, respuesta_b, respuesta_c, respuesta_d, respuesta_e, persona_id]
      );

      // Auto-crear cita de seguimiento basado en respuesta_e
      if (respuesta_e) {
        const tiposCita = {
          'RELLAMADA': 'LLAMADA',
          'INFORMACION': 'LLAMADA',
          'ZOOM': 'ZOOM',
          'OFICINA': 'OFICINA',
          'CAMPO': 'CAMPO',
          'CONTRATO': 'LLAMADA',
          'OTRO': 'LLAMADA'
        };

        const tipoCita = tiposCita[respuesta_e] || 'LLAMADA';
        const fechaSeguimiento = new Date();
        fechaSeguimiento.setDate(fechaSeguimiento.getDate() + 2);

        try {
          await bd.query(
            `INSERT INTO citas (persona_id, tipo, fecha, hora, estado, creado_en)
             VALUES ($1, $2, $3, '10:00', 'pendiente', NOW())`,
            [persona_id, tipoCita, fechaSeguimiento.toISOString().split('T')[0]]
          );
        } catch (err) {
          console.warn('[cita auto-creada fallo]', err.message);
          // No fallar el request si la cita no se crea
        }
      }

      return res.status(200).json({
        resultado: 'calificado',
        respuestas: { respuesta_a, respuesta_b, respuesta_c, respuesta_d, respuesta_e }
      });
    }

    return res.status(400).json({ error: 'Parámetros inválidos' });
  } catch (err) {
    console.error('[api/citas POST calificar]', err);
    return res.status(500).json({ error: 'Error al calificar lead' });
  }
}

async function agendarCita(req, res) {
  try {
    const { persona_id, tipo, fecha, hora } = req.body;
    const bd = obtenerPool();

    if (!persona_id || !tipo || !fecha || !hora) {
      return res.status(400).json({ error: 'Faltan datos para agendar cita' });
    }

    await bd.query(
      `INSERT INTO citas (persona_id, tipo, fecha, hora, estado, creado_en)
       VALUES ($1, $2, $3, $4, 'pendiente', NOW())`,
      [persona_id, tipo, fecha, hora]
    );

    return res.status(200).json({ resultado: 'agendada' });
  } catch (err) {
    console.error('[api/citas POST agendar]', err);
    return res.status(500).json({ error: 'Error al agendar cita' });
  }
}

module.exports = (req, res) => {
  if (req.method === 'GET') return getCitas(req, res);
  if (req.method === 'POST') return postCitas(req, res);
  res.status(405).json({ error: 'Método no permitido' });
};
