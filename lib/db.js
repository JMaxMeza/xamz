// Conexión a Postgres, compartida por las tres funciones (`api/registro.js`,
// `api/crm.js`, `api/bot.js`).
//
// Vive acá y no en cada handler porque la configuración de TLS es delicada y
// tener tres copias es tener tres cosas que se desincronizan: la CA vence el
// 2031 y el día que haya que cambiarla hay que cambiarla en UN lugar.

const { Pool, types } = require('pg');
const { CA_SUPABASE } = require('./supabase-ca');

// `pg` devuelve los BIGINT (oid 20) como STRING, porque no siempre caben en un
// Number de JS. El panel del CRM compara ids con `===` contra números
// (`parseInt(data-vista)`), y "7" === 7 es false: el marcado local no ocurría
// nunca y "Marcar vista" no hacía nada visible hasta el sondeo siguiente.
// Se convierten acá, que es un solo sitio, y solo cuando el valor cabe de
// verdad en un Number; si algún día no cabe, se deja el string y el problema
// se ve en vez de convertirse en un id equivocado.
types.setTypeParser(20, (valor) => {
  const n = Number(valor);
  return Number.isSafeInteger(n) ? n : valor;
});

// La integración oficial de Supabase con Vercel inyecta `POSTGRES_URL` sola,
// sin que nadie copie la cadena a mano — que es como conviene hacerlo, porque
// lleva la contraseña dentro. `DATABASE_URL` se sigue aceptando para el caso
// de poner la variable a mano o de mudarse a otro Postgres.
function cadenaConexion() {
  const cruda = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!cruda) return '';
  // `pg` deja que lo que venga DENTRO de la cadena pise la configuración que
  // se le pasa aparte, no al revés. Así que un `?sslmode=require` en la URL
  // anula el `ssl: { ca }` de más abajo y la conexión vuelve a morir con
  // SELF_SIGNED_CERT_IN_CHAIN. Se quita ese parámetro para que el TLS se
  // decida en un solo sitio: acá, verificando contra la CA de Supabase.
  try {
    const u = new URL(cruda);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch (e) {
    return cruda;
  }
}

// Un pool por proceso. Vercel reutiliza la instancia entre invocaciones, así
// que crear uno por request abriría conexiones nuevas contra el pooler en cada
// mensaje. Cada función se despliega por separado, así que cada una tiene el
// suyo. `nombre` es solo para que el log diga qué función tuvo el problema.
//
// `max` se deja elegir porque las tres funciones no hacen lo mismo:
// `registro.js` es un solo INSERT y le sobra con 1, mientras que `datos` del
// CRM lanza 4 lecturas en paralelo. Poner 4 en todas abriría conexiones que
// nadie va a usar contra un pooler compartido.
let pool;
function obtenerPool(nombre, opciones) {
  if (!pool) {
    pool = new Pool({
      connectionString: cadenaConexion(),
      // Verificar contra la CA de Supabase, no contra el almacén de Node.
      // Se pasa explícito y gana sobre lo que diga el `sslmode` de la cadena.
      ssl: { ca: CA_SUPABASE },
      max: (opciones && opciones.max) || 4,
      idleTimeoutMillis: 10000,
      // El límite por defecto de una función Node en Vercel es 10 s. Con 8 s
      // esperando la conexión, un arranque en frío con la base también fría se
      // comía el presupuesto entero y la plataforma cortaba con un 504 sin
      // JSON. Con 5 s quedan otros 5 para las consultas.
      connectionTimeoutMillis: 5000,
      // Y que una consulta colgada no se lleve por delante el resto de la
      // invocación: se corta sola y el error se ve en el log. Es el corte del
      // lado del cliente (un temporizador de `pg`), no `statement_timeout`:
      // ese viaja en los parámetros de arranque de la conexión y un pooler en
      // modo transacción puede rechazarlo, y entonces no falla una consulta,
      // falla la conexión entera.
      query_timeout: 6000,
    });
    // Sin oyente, el error de una conexión ociosa caída tumba el proceso.
    pool.on('error', (err) => {
      console.error(`${nombre || 'db'}: conexión ociosa del pool caída:`, err.message);
    });
  }
  return pool;
}

// El formulario manda '+51 999 888 777' y WhatsApp '51999888777'. Se guarda
// siempre en dígitos para que las dos puntas se encuentren.
function soloDigitos(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/\D/g, '')
    .slice(0, 20);
}

module.exports = { cadenaConexion, obtenerPool, soloDigitos };
