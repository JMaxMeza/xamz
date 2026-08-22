// Tope de tasa por IP, en memoria de la instancia.
//
// ⚠️ Es **best-effort a propósito, y no sustituye a un limitador de verdad.**
// El contador vive en la memoria del proceso y Vercel puede levantar varias
// instancias, así que el techo real es el configurado × el número de
// instancias vivas. Lo que corta es el caso concreto que se quiere cortar:
// alguien probando claves a mano o con un script simple, y el formulario
// llenado en bucle. Un ataque distribuido pasa por encima de esto, y para eso
// hace falta estado compartido (una tabla en Postgres o algo tipo Upstash),
// que es una decisión de arquitectura y una dependencia más.
//
// Está acá y no copiado en cada handler porque ya son dos los que lo usan, con
// políticas distintas, y la tercera copia es donde estas cosas empiezan a
// divergir.

function ipDe(req) {
  const cabeceras = (req && req.headers) || {};
  const cruda = cabeceras['x-forwarded-for'] || cabeceras['x-real-ip'] || '';
  const primera = String(Array.isArray(cruda) ? cruda[0] : cruda).split(',')[0].trim();
  return primera || (req && req.socket && req.socket.remoteAddress) || 'sin-ip';
}

// `maxIps` es un techo de memoria: la tabla no puede crecer sola en un proceso
// que vive horas.
function crearTope({ max, ventanaMs, maxIps = 500 }) {
  const cuentas = new Map();

  function excedido(ip) {
    const registro = cuentas.get(ip);
    if (!registro) return false;
    if (Date.now() - registro.desde > ventanaMs) {
      cuentas.delete(ip);
      return false;
    }
    return registro.intentos >= max;
  }

  function anotar(ip) {
    const ahora = Date.now();
    const registro = cuentas.get(ip);
    if (!registro || ahora - registro.desde > ventanaMs) {
      cuentas.set(ip, { intentos: 1, desde: ahora });
    } else {
      registro.intentos++;
    }
    if (cuentas.size > maxIps) {
      for (const [clave, valor] of cuentas) {
        if (ahora - valor.desde > ventanaMs) cuentas.delete(clave);
      }
      // Si aun así no baja, se vacía: perder el conteo es preferible a que la
      // tabla crezca sin techo.
      if (cuentas.size > maxIps) cuentas.clear();
    }
  }

  function limpiar(ip) {
    cuentas.delete(ip);
  }

  return { excedido, anotar, limpiar, ventanaMs, max };
}

module.exports = { crearTope, ipDe };
