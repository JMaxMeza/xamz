// XAMZ Bandeja Fase 2 - Calificación de Leads
// Vista de bandeja de citas con panel de nuevos leads sin contactar

const MOTIVOS_PERDIDA = [
  'NO_RESPONDE', 'SIN_CAPACIDAD', 'PRECIO_ELEVADO', 'NO_CONFIA',
  'RIESGO_AGRICOLA', 'DUDAS_CONTRACTUALES', 'RENTABILIDAD_BAJA',
  'DESEA_VISITAR', 'CONSULTAR_FAMILIA', 'NO_ES_MOMENTO',
  'OTRA_INVERSION', 'DESISTIO_POST_RESERVA', 'NO_BUSCABA_INVERTIR',
  'LEAD_DUPLICADO', 'DATOS_FALSOS', 'OTRO'
];

export async function renderBandeja(container) {
  const html = `
    <div id="b-container">
      <div id="b-notificaciones" class="notificaciones-panel"></div>
      <div id="b-citas" class="citas-container"></div>
    </div>
  `;
  container.innerHTML = html;

  await cargarDatos();
}

async function cargarDatos() {
  try {
    const res = await fetch('/api/citas', { method: 'GET' });
    const data = await res.json();

    if (data.nuevos_sin_contactar?.length > 0) {
      paintNotificaciones(data.nuevos_sin_contactar);
    }

    if (data.citas?.length > 0) {
      paintCitas(data.citas);
    }
  } catch (err) {
    console.error('Error cargando bandeja:', err);
  }
}

function paintNotificaciones(nuevos) {
  const panel = document.getElementById('b-notificaciones');
  panel.innerHTML = `<h3>📌 ${nuevos.length} nuevos leads sin contactar</h3>`;

  nuevos.forEach(lead => {
    const item = document.createElement('div');
    item.className = 'notificacion-item';
    item.innerHTML = `
      <div class="lead-info">
        <strong>${lead.nombre}</strong>
        <small>${lead.telefono}</small>
      </div>
      <button onclick="window.contactarLead(${lead.id})">Responder</button>
    `;
    panel.appendChild(item);
  });
}

function paintCitas(citas) {
  const container = document.getElementById('b-citas');
  container.innerHTML = '<h3>Citas Pendientes</h3>';

  citas.forEach(cita => {
    const item = document.createElement('div');
    item.className = 'cita-item';
    item.innerHTML = `
      <strong>${cita.nombre}</strong>
      <p>${cita.tipo} - ${cita.fecha} ${cita.hora}</p>
    `;
    container.appendChild(item);
  });
}

window.contactarLead = function(personaId) {
  const modal = document.createElement('div');
  modal.id = 'modal-calificar';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Calificar Lead</h2>

      <label>¿Contactado?
        <input type="radio" name="contactado" value="true" checked> Sí
        <input type="radio" name="contactado" value="false"> No
      </label>

      <fieldset id="preguntas">
        <legend>Preguntas de Calificación</legend>

        <label>A. ¿Comprendió la propuesta?
          <input type="radio" name="respuesta_a" value="SI"> Sí
          <input type="radio" name="respuesta_a" value="NO"> No
        </label>

        <label>B. ¿Manifestó interés real?
          <input type="radio" name="respuesta_b" value="SI"> Sí
          <input type="radio" name="respuesta_b" value="NO"> No
        </label>

        <label>C. ¿Existe posibilidad económica?
          <input type="radio" name="respuesta_c" value="SI"> Sí
          <input type="radio" name="respuesta_c" value="NO"> No
          <input type="radio" name="respuesta_c" value="POR_VALIDAR"> Por validar
        </label>

        <label>D. Horizonte de decisión
          <select name="respuesta_d">
            <option value="">Selecciona...</option>
            <option value="0-7">0-7 días</option>
            <option value="8-30">8-30 días</option>
            <option value="31-90">31-90 días</option>
            <option value="+90">+90 días</option>
            <option value="INDEFINIDO">Indefinido</option>
          </select>
        </label>

        <label>E. Próximo paso comercial
          <select name="respuesta_e">
            <option value="">Selecciona...</option>
            <option value="RELLAMADA">Rellamada</option>
            <option value="INFORMACION">Enviar información</option>
            <option value="ZOOM">Llamada Zoom</option>
            <option value="OFICINA">Visita a oficina</option>
            <option value="CAMPO">Visita al campo</option>
            <option value="CONTRATO">Ir a contrato</option>
            <option value="OTRO">Otro</option>
          </select>
        </label>
      </fieldset>

      <fieldset id="motivos" style="display:none;">
        <legend>Motivo de Pérdida</legend>
        <div id="motivos-list"></div>
        <textarea name="comentario_perdida" placeholder="Comentario (requerido si selecciona OTRO)"></textarea>
      </fieldset>

      <div class="modal-buttons">
        <button onclick="document.getElementById('modal-calificar').remove()">Cancelar</button>
        <button onclick="guardarCalificacion(${personaId})">Guardar</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Event listeners
  document.querySelectorAll('input[name="contactado"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const preguntas = document.getElementById('preguntas');
      const motivos = document.getElementById('motivos');
      if (e.target.value === 'true') {
        preguntas.style.display = 'block';
        motivos.style.display = 'none';
      } else {
        preguntas.style.display = 'none';
        motivos.style.display = 'block';
      }
    });
  });

  // Renderizar motivos
  const motivosList = document.getElementById('motivos-list');
  MOTIVOS_PERDIDA.forEach(motivo => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="motivo_perdida" value="${motivo}"> ${motivo}
    `;
    motivosList.appendChild(label);
  });
};

async function guardarCalificacion(personaId) {
  const contactadoValue = document.querySelector('input[name="contactado"]:checked')?.value;
  const contactado = contactadoValue === 'true';

  const body = { persona_id: personaId, contactado, accion: 'calificar' };

  if (contactado) {
    body.respuesta_a = document.querySelector('input[name="respuesta_a"]:checked')?.value;
    body.respuesta_b = document.querySelector('input[name="respuesta_b"]:checked')?.value;
    body.respuesta_c = document.querySelector('input[name="respuesta_c"]:checked')?.value;
    body.respuesta_d = document.querySelector('select[name="respuesta_d"]')?.value;
    body.respuesta_e = document.querySelector('select[name="respuesta_e"]')?.value;
  } else {
    body.motivo_perdida = document.querySelector('input[name="motivo_perdida"]:checked')?.value;
    body.comentario_perdida = document.querySelector('textarea[name="comentario_perdida"]')?.value;
  }

  try {
    const res = await fetch('/api/citas', { method: 'POST', body: JSON.stringify(body) });
    const result = await res.json();

    document.getElementById('modal-calificar').remove();
    await cargarDatos(); // Recargar bandeja
    alert('Calificación guardada');
  } catch (err) {
    console.error('Error guardando:', err);
    alert('Error al guardar');
  }
}

// CSS
const style = document.createElement('style');
style.textContent = `
  #b-notificaciones {
    background: #fff3cd;
    border-left: 4px solid #ffc107;
    padding: 16px;
    margin-bottom: 20px;
  }

  .notificacion-item {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #ffe0a3;
  }

  .modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: white;
    padding: 24px;
    border-radius: 8px;
    max-width: 500px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  }

  fieldset {
    border: 1px solid #ddd;
    padding: 12px;
    margin: 12px 0;
  }

  label { display: block; margin: 8px 0; }
  input, select, textarea { margin-left: 8px; }

  .modal-buttons {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  .modal-buttons button {
    flex: 1;
    padding: 8px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .modal-buttons button:last-child {
    background: #007bff;
    color: white;
  }
`;
document.head.appendChild(style);
