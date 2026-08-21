# Mining Big — landing de registro

Landing page para captar registros de clientes de alquiler de maquinaria pesada
(excavadoras, volquetes, cargadores, perforadoras, etc.).

[`index.html`](index.html) lleva el HTML, el CSS y el JS embebidos. Desde el
2026-08-19 el proyecto ya no es 100% estático: tiene funciones serverless en
`api/`. El **2026-08-20** se le sumó el CRM, así que ya no queda nada corriendo
en n8n:

| Pieza | Archivo | Reemplaza a |
|---|---|---|
| Captura de registros | [`api/registro.js`](api/registro.js) | webhook `registro-mining-big` |
| API del CRM | [`api/crm.js`](api/crm.js) | workflow `Q53HZ7R1ueJrJqUo` |
| Panel del CRM | [`crm/index.html`](crm/index.html) | — (ya era estático) |

> [!warning] El bot de WhatsApp **sigue en n8n y sigue caído**
> El CRM lee y escribe en Postgres, pero quien llena las tablas de
> conversaciones, mensajes y alertas es el bot, que no se migró. Hasta que se
> migre, la pestaña **Solicitudes funciona con datos reales** y **Chats y
> Alertas quedan vacías**. Escribir como asesor sí funciona: esa acción llama
> directo a la API de WhatsApp, sin pasar por el bot.

## Captura de registros

El formulario hace `POST` a `/api/registro` — **ruta relativa, mismo dominio**,
así que no hay CORS de por medio.

El **folio lo genera el servidor** y vuelve en la respuesta: el que ve el cliente
es el mismo que queda guardado. Si el envío falla, la landing muestra un error y
**no** muestra folio — prometer un registro que no se guardó es peor que fallar
de forma visible.

> Antes esto era un webhook de n8n
> (`m4xx.app.n8n.cloud/webhook/registro-mining-big`). Se migró cuando venció la
> prueba gratuita de n8n Cloud y los registros dejaron de guardarse durante
> varios días sin que nadie se enterara. La función hace lo mismo, sobre
> Postgres propio.

### Contrato del endpoint

`POST /api/registro`

```json
{
  "nombre": "...", "empresa": "...", "email": "...", "telefono": "...",
  "zona": "...", "plazo": "...", "equipo": ["Excavadora", "Volquete"],
  "detalle": "..."
}
```

- Obligatorios: `nombre`, `empresa`, `email`, `telefono`. Faltando alguno → `400`.
- `equipo` llega como array y se guarda unido por `", "` en la columna `equipos`.
- Respuesta OK: `{ "ok": true, "folio": "MB-260819-4821" }`.
- Errores: `{ "ok": false, "error": "..." }` con 400 / 405 / 500.

## Puesta en marcha

### 1. Base de datos

Cualquier Postgres gestionado sirve (Neon, Supabase, Vercel Postgres…). El
código usa `pg` y SQL estándar, sin nada específico de un proveedor: si mañana
hay que mudarse, se cambia la URL y ya.

En el editor SQL del proveedor, correr en este orden:

1. [`db/schema.sql`](db/schema.sql) — crea la tabla `registros`.
2. [`db/schema-crm.sql`](db/schema-crm.sql) — crea `conversaciones`, `mensajes`
   y `alertas`, las tres tablas que lee el CRM.
3. [`db/migracion-registros.sql`](db/migracion-registros.sql) — mete los 3
   registros reales que quedaron atrapados en n8n. Las 6 filas de prueba están
   comentadas a propósito. Es idempotente: se puede correr dos veces.
4. [`db/mejoras-crm-2026-08-21.sql`](db/mejoras-crm-2026-08-21.sql) — el índice
   que faltaba para la consulta que el panel repite cada 45 s, más una
   comprobación de que los teléfonos guardados son dígitos puros. **Hay que
   correrlo también en una base que ya esté creada**: `schema-crm.sql` usa
   `IF NOT EXISTS`, así que volver a correrlo entero también sirve.

**No hay migración de datos para las tres tablas del CRM.** Su contenido se
quedó dentro de n8n y la prueba venció antes de poder exportarlo; eran sobre
todo filas de prueba (ver la wiki). Arrancan vacías.

Copia cruda de lo exportado, por si acaso:
[`db/registros-n8n-export.json`](db/registros-n8n-export.json).

**Usar la cadena de conexión *pooled***, no la directa. Las funciones
serverless abren y cierran conexiones todo el tiempo y un Postgres sin pooler
se queda sin slots.

### 2. Variable de entorno en Vercel

En *Settings → Environment Variables* del proyecto:

> [!tip] La cadena de conexión mejor no copiarla a mano
> La **integración oficial de Supabase con Vercel** inyecta `POSTGRES_URL`
> (ya pooled) sola, y las dos funciones la aceptan como alternativa a
> `DATABASE_URL`. Es preferible: esa cadena lleva la contraseña de la base
> dentro, y así no pasa por el portapapeles de nadie.
>
> Si se ponen las dos, manda `DATABASE_URL`.

| Variable | Valor | Para qué |
|---|---|---|
| `DATABASE_URL` *(o `POSTGRES_URL`)* | la cadena pooled, con `?sslmode=require` | las dos funciones |
| `CRM_CLAVE` | la clave de acceso al panel | `api/crm.js` |
| `WHATSAPP_TOKEN` | token permanente de la app de Meta | escribir como asesor |
| `WHATSAPP_PHONE_ID` | id del número emisor (Meta) | escribir como asesor |

Marcarlas para Production, Preview y Development. **Hay que redeployar** después
de agregarlas: las variables se inyectan en el build, no en caliente.

**La clave del CRM va en `CRM_CLAVE` y en ningún archivo.** En n8n estaba
escrita dentro del workflow; acá el código no la contiene, así que el repo se
puede leer sin que se filtre. Sin esa variable, `api/crm.js` responde 500 con
"panel no configurado" — a propósito, para que no haya un modo "sin clave" en
el que el panel quede abierto.

Las dos de WhatsApp son las que ya usaba el bot en n8n (credencial *WhatsApp
Business Cloud*). Sin ellas todo el CRM funciona menos el botón de enviar, que
responde "WhatsApp no configurado en el servidor" en vez de fingir que salió.

### 3. Desplegar

Este repo **no tiene remoto de git configurado** y los deploys se venían
haciendo con la CLI. Con la CLI de Vercel instalada:

```bash
vercel --prod
```

Si no hay Node en la máquina, la alternativa —y la más sana a largo plazo— es
conectar el repo a GitHub y dejar que Vercel despliegue en cada push.

> **El repositorio TIENE que ser privado.** No es una preferencia: `db/` está
> versionado y lleva nombre, correo y celular de clientes reales
> (`registros-n8n-export.json`, `migracion-registros.sql` y los tres `INSERT`
> de `todo-en-uno.sql`). En GitHub, la pantalla de crear repositorio ofrece
> **Público** arriba y preseleccionado. Un push a un repo público publica esos
> datos **y los deja en el historial para siempre**: borrar el archivo después
> no los saca del commit, y los forks y mirrors de terceros ya no se controlan.
> Ley 29733 de protección de datos personales.
>
> `.vercelignore` excluye `db/` del **sitio desplegado**, que es un problema
> distinto y ya está resuelto. No protege nada en git.

```bash
git remote add origin https://github.com/USUARIO/REPO.git   # repo PRIVADO
git push -u origin main
```

Luego importar el repo en https://vercel.com/new con **Framework Preset: Other**.
Vercel detecta la carpeta `api/` sola e instala las dependencias de
`package.json`; no hay que configurar build.

### 4. Verificar

```bash
curl -i -X POST https://mining-big.com/api/registro -H "Content-Type: application/json" -d "{\"nombre\":\"Prueba\",\"empresa\":\"Test\",\"email\":\"a@b.com\",\"telefono\":\"999\"}"
```

Debe devolver `200` con un folio. Sin campos obligatorios debe devolver `400`.
Después, borrar la fila de prueba.

Y el CRM — primero que rechace una clave mala:

```bash
curl -i -X POST https://mining-big.com/api/crm -H "Content-Type: application/json" -d "{\"clave\":\"incorrecta\",\"action\":\"datos\"}"
```

Debe devolver `401`. Con la clave buena debe devolver `200` y un JSON con las
cuatro colecciones (`registros`, `conversaciones`, `mensajes`, `alertas`); las
tres últimas vacías hasta que se migre el bot. Después, entrar a
`https://mining-big.com/crm/` y comprobar que la pestaña Solicitudes lista los
registros reales y que el check *Atendido* sobrevive a recargar la página.

Repetir la clave mala **once veces seguidas** debe acabar en `429` con
`Retry-After: 300` (tope de intentos fallidos por IP, ver *Pendiente*). No pasa
nada por dispararlo en la verificación: solo bloquea a esa IP y solo durante
cinco minutos, y **únicamente cuenta los fallos** — con la clave correcta se
entra igual.

Las cabeceras de `/crm/` las fija [`vercel.json`](vercel.json): `X-Frame-Options`,
`nosniff`, `Referrer-Policy` y una CSP que, entre otras cosas, impide que un
script de la página mande datos a otro dominio (`connect-src 'self'`). Si algún
día el panel necesita cargar algo de fuera —una fuente, una imagen, otra API—,
hay que abrirlo ahí; si no, falla en silencio salvo por la consola.

## Pendiente

- **Datos de contacto del pie** — el teléfono y el correo siguen siendo de
  ejemplo (`+00 000 000 000`). Los reales son `Gerencia@mining-big.com` y
  `+51 934 747 464`.
- **El endpoint es público y sin autenticación.** Hoy solo hay validación de
  campos y topes de longitud. Si empieza a llegar spam, hace falta un captcha o
  un rate limit por IP.
- **El bot de WhatsApp sigue en n8n**, y es la última pieza que queda ahí. Es
  la que llena las tablas de conversaciones, mensajes y alertas: hasta que se
  migre, dos de las tres pestañas del CRM están vacías aunque el panel
  funcione. Es la siguiente migración.
- **La clave del CRM sigue siendo un secreto compartido** que viaja en el body
  y vive en `localStorage`. No hay usuarios ni roles. Alcanza para un asesor;
  si entra un segundo, hace falta login de verdad.
- **`/api/registro` no tiene tope de tasa** y es público. Si empieza a llegar
  spam, hace falta un captcha o un límite por IP.
- **El tope de tasa de `/api/crm` es parcial**: desde el 2026-08-21 corta con
  `429` a las 10 claves fallidas seguidas de una misma IP en 5 minutos, pero el
  contador vive **en la memoria de cada instancia** de la función. Con varias
  instancias en paralelo el techo real es más alto, y un ataque distribuido no
  lo nota. Frena lo que hay que frenar hoy (probar claves a mano o con un
  script simple); un límite de verdad necesitaría almacenamiento compartido.
- **El panel se trae el historial completo de mensajes en cada sondeo** (cada
  45 s con la pestaña visible, cada 5 min en segundo plano) y lo filtra en el
  navegador. `api/crm.js` lo topa en 4 000 mensajes y avisa con
  `mensajes_recortados`; el panel ahora **muestra ese aviso en la pestaña
  Chats**. El día que aparezca, hay que paginar por conversación.
- **Avisos al asesor**: el workflow viejo tenía nodos de email y WhatsApp, los
  dos deshabilitados por falta de credenciales. No se migraron porque nunca
  llegaron a funcionar.
