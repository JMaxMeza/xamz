# Mining Big — landing de registro

Landing page para captar registros de clientes de alquiler de maquinaria pesada
(excavadoras, volquetes, cargadores, perforadoras, etc.).

[`index.html`](index.html) lleva el HTML, el CSS y el JS embebidos. Desde el
2026-08-19 el proyecto ya no es 100% estático: tiene funciones serverless en
`api/`. Con el bot reconstruido el **2026-08-21**, **no queda nada corriendo en
n8n** — que es la regla de la agencia, no una casualidad: ver
`wiki/conceptos/sin-n8n.md`.

| Pieza | Archivo | Reemplaza a |
|---|---|---|
| Captura de registros | [`api/registro.js`](api/registro.js) | webhook `registro-mining-big` |
| API del CRM | [`api/crm.js`](api/crm.js) | workflow `Q53HZ7R1ueJrJqUo` |
| Bot de WhatsApp | [`api/bot.js`](api/bot.js) | workflow `QUnvDABERd9tfckF` |
| Correo entrante | [`api/correo.js`](api/correo.js) | — (nuevo) |
| Panel del CRM | [`crm/index.html`](crm/index.html) | — (ya era estático) |
| Textos del bot | [`lib/bot-contenido.js`](lib/bot-contenido.js) | los 8 nodos Set de respuesta |
| Compartido | [`lib/db.js`](lib/db.js), [`lib/whatsapp.js`](lib/whatsapp.js), [`lib/correo.js`](lib/correo.js), [`lib/tope-tasa.js`](lib/tope-tasa.js), [`lib/peticion.js`](lib/peticion.js) | — |

> [!success] Desplegado y verificado en producción el 2026-08-21
> Las tres migraciones están aplicadas sobre la base real, el sitio está en
> `https://mining-big.com` y **29 comprobaciones contra el dominio pasan**,
> incluida la de extremo a extremo: la landing guarda un registro, el CRM lo
> ve al instante, *Atendido* persiste, y el tope de tasa corta. Las filas de
> prueba se borraron; la base quedó con los 3 registros reales y nada más.

> [!warning] Faltan dos conexiones con terceros, y las dos son de cuenta ajena
> 1. **El webhook de Meta no apunta al bot.** El endpoint responde la
>    verificación, pero hasta que Meta no lo apunte, **nadie contesta a los
>    clientes que escriben** y las pestañas Chats y Alertas siguen vacías.
>    Falta además `WHATSAPP_APP_SECRET`, sin la cual el bot **rechaza todo**
>    (ver *Anti-duplicado y firma*).
> 2. **No hay proveedor de correo contratado.** El botón de correo dice
>    "el correo no está configurado en el servidor", que es la verdad.
>
> Lo que sí funciona hoy: la landing, la captación de registros, y el panel con
> Solicitudes sobre datos reales.

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

## Bot de WhatsApp

[`api/bot.js`](api/bot.js) — una sola ruta con los dos métodos que Meta usa:

| Método | Para qué |
|---|---|
| `GET /api/bot` | verificación del webhook. Devuelve `hub.challenge` si `hub.verify_token` coincide con `WHATSAPP_VERIFY_TOKEN`; si no, 403. |
| `POST /api/bot` | los mensajes. 401 si la firma no valida, 200 en todo lo demás. |

**Dos modos**, como el bot original:

- **FAQ** — menú guiado, sin LLM. Enruta por número exacto o por palabra clave
  a 5 respuestas + el menú, y el fallback repite el menú: el bot nunca deja al
  usuario sin salida.
- **Cuestionario** — 6 preguntas de calificación que arrancan cuando el cliente
  llega desde la landing con su folio en el texto
  (`Hola, acabo de registrarme. Folio MB-260803-7500`). En cualquier pregunta,
  `0` termina y `9` deriva al asesor.

### Los textos se editan sin tocar código

Todo lo que el bot dice, las palabras clave de cada rama y las 6 preguntas
están en [`lib/bot-contenido.js`](lib/bot-contenido.js), que es texto entre
comillas y listas de palabras. La lógica está en `api/bot.js` y no hace falta
abrirla para cambiar una respuesta.

> [!warning] El orden de `RAMAS` es una decisión de producto
> Gana la **primera** rama que coincide. *Tarifas va antes que Flota a
> propósito*: al revés, "cuanto cuesta un volquete" caía en Flota y el cliente
> recibía un catálogo en vez de una respuesta de precio.

### Qué hace con el CRM

- Registra **cada** mensaje en `mensajes` (entrante antes de decidir nada,
  saliente solo si Meta aceptó). Un fallo del registro nunca calla al bot.
- Obedece el interruptor `bot_activo` de `conversaciones`: en `false`, registra
  lo que llega y **no contesta** — el asesor tomó el chat. `NULL` o vacío es
  encendido.
- Inserta en `alertas` cuando el cliente pide un asesor (opción 5 o palabra
  clave en FAQ, opción 9 en el cuestionario). El panel lo notifica.

### Anti-duplicado

Meta reintenta el webhook si no recibe el 200 a tiempo — en producción se
midieron hasta **4 entregas por cada mensaje del usuario**. El bot guarda el
`messages[0].id` de Meta en `mensajes.wa_id`, con índice único parcial, y si el
INSERT no inserta nada es que ese mensaje ya se procesó: responde 200 y no
contesta de nuevo.

**La contrapartida, escrita para que nadie se sorprenda:** si el proceso se
cae *entre* registrar el entrante y contestar, el reintento de Meta se
descarta por duplicado y ese mensaje queda sin respuesta. El cliente escribe
otra vez y el mensaje igual está en el CRM para que lo vea el asesor. Se
prefirió eso a que el cliente reciba la misma respuesta cuatro veces.

### Cuando Meta entrega y no llega nada

Antes que cualquier otra cosa, revisar a qué app está suscrita la cuenta:

```
GET 2207461680028791/subscribed_apps
```

Si la app propia no está en la lista, ese es el problema (`POST` a la misma
ruta lo arregla). Es traicionero porque los webhooks de **prueba** del panel de
Meta salen desde la app y **sí llegan**, mientras que los mensajes **reales**
van solo a la app suscrita a la cuenta. Costó media jornada la primera vez.

## Correo

El asesor podía escribirle al cliente por WhatsApp desde el panel, pero ahí
manda la **ventana de 24 h de Meta**: pasado ese rato solo salen plantillas
preaprobadas. El correo no tiene esa limitación y es la dirección que el
cliente dejó en el formulario, así que es el canal que sirve para el
seguimiento — que es justo cuando el CRM hace falta.

| Pieza | Qué hace |
|---|---|
| Pestaña **Correos** del panel | lista de hilos, hilo completo y redacción con asunto |
| `enviar_correo` en `api/crm.js` | envía y guarda en `correos` |
| [`lib/correo.js`](lib/correo.js) | la capa de proveedor |
| [`api/correo.js`](api/correo.js) | webhook de entrada: las respuestas del cliente |

En la pestaña **Solicitudes**, el botón *Correo* de cada solicitud abre el hilo
de ese cliente directamente — el correo ya está en la solicitud, no hay que
copiarlo a otra pestaña. La lista de hilos incluye también a los clientes a los
que todavía no se les escribió, para poder mandar el primero.

El badge de la pestaña cuenta **hilos donde lo último es del cliente**: los que
están esperando respuesta. Contar hilos a secas no dice nada accionable.

### El proveedor está aislado a propósito

La lección de `wiki/conceptos/sin-n8n.md` es reciente: tres sistemas murieron a
la vez porque dependían de un servicio alojado que se apagó. Para el correo
hace falta *alguien* que lo entregue, pero el daño se acota si cambiar de
proveedor es escribir una función en `lib/correo.js` y tocar dos variables.

Está implementado **Resend**, elegido por tres razones concretas: habla HTTP
(así que **no agrega ninguna dependencia npm** — el proyecto sigue con `pg`
como única), verifica el dominio propio que ya existe (mining-big.com), y tiene
entrada de correo para las respuestas. Agregar otro es agregar una entrada al
objeto `PROVEEDORES`.

> [!success] Entregado y verificado de punta a punta el 2026-09-02
> Enviar funciona desde el 2026-09-01 22:57 (primer correo real recibido en
> una bandeja externa); recibir funciona desde el 2026-09-02, con el cuerpo
> real del mensaje, no solo metadata. Detalle completo de cómo quedó armado el
> DNS y los tres tropiezos reales (dominio raíz vs. subdominio, el webhook sin
> cuerpo, el permiso de la API key) en [[crm-mining-big]] → *Proveedor de
> correo: Resend*.

**Cómo quedó armado**, en una tabla — dos identidades de dominio separadas en
Resend, ninguna toca el DNS que ya usa Microsoft 365:

| Rol | Dominio en Resend | Variable |
|---|---|---|
| Enviar | `mining-big.com` (el dominio raíz — verificado ahí, no en un subdominio) | `CORREO_REMITENTE` = `Mining Big <gerencia@mining-big.com>` |
| Recibir | `responde.mining-big.com` (subdominio, dominio **aparte** en Resend) | `CORREO_RESPONDER_A` = `respuestas@responde.mining-big.com` |

`CORREO_RESPONDER_A` (ya estaba en `lib/correo.js`, sin usar hasta ahora) es
lo que hace que esto sea invisible para el cliente: el remitente que ve sigue
siendo `gerencia@mining-big.com`, pero la respuesta viaja por `Reply-To` hacia
el subdominio que sí puede recibir.

### El proveedor está aislado a propósito

La lección de `wiki/conceptos/sin-n8n.md` es reciente: tres sistemas murieron a
la vez porque dependían de un servicio alojado que se apagó. Para el correo
hace falta *alguien* que lo entregue, pero el daño se acota si cambiar de
proveedor es escribir una función en `lib/correo.js` y tocar dos variables.

Está implementado **Resend**, elegido por tres razones concretas: habla HTTP
(así que **no agrega ninguna dependencia npm** — el proyecto sigue con `pg`
como única), verifica el dominio propio que ya existe (mining-big.com), y tiene
entrada de correo para las respuestas. Agregar otro es agregar una entrada al
objeto `PROVEEDORES`.

### La entrada de correo: firma verificada, payload confirmado contra un correo real

`POST /api/correo` verifica la **firma Svix real de Resend** en
`svix-signature` (2026-09-01) — HMAC-SHA256 sobre `id.timestamp.cuerpo`, con
tolerancia de reloj de 5 minutos contra repetición. El algoritmo se comprobó
contra el vector de prueba oficial de Svix, byte a byte, no solo "no tira
error". **No hay modo "pasa igual y avisa"** como en el bot: este endpoint
escribe en la base, así que sin `CORREO_WEBHOOK_SECRET` configurado responde
500 y no atiende a nadie.

`CORREO_WEBHOOK_SECRET` **cambió de contenido, no de nombre**: ya no es el
secreto arbitrario que se usaba con la cabecera `x-mb-secreto` (eso se retiró
entero) — es el *signing secret* que la consola de Resend entrega al crear el
endpoint del webhook, con forma `whsec_...`.

> [!bug] El webhook de Resend no trae el cuerpo del correo — hay que pedirlo aparte
> Confirmado el 2026-09-02 con un correo real: el payload de `email.received`
> trae `from`, `subject`, `message_id`, `email_id` y metadata — **nunca `text`
> ni `html`**. `interpretar()` asumía que el cuerpo venía en el propio webhook
> (como mandan Mailgun o Postmark); para Resend es al revés: el webhook es solo
> una notificación, y el cuerpo real se pide con
> `GET https://api.resend.com/emails/receiving/{email_id}`
> ([referencia oficial](https://resend.com/docs/api-reference/emails/retrieve-received-email)).
> Sin ese segundo viaje, el correo se guardaba con folio y remitente
> correctos y **el cuerpo vacío** — no fallaba, así que no se notaba solo. Ya
> está resuelto en `api/correo.js` (`obtenerCorreoCompleto()`), y si esa
> segunda llamada falla se responde 500 a propósito para que Resend reintente
> el webhook entero — guardar con el cuerpo vacío es peor que tardar un poco
> más en tenerlo bien.
>
> **Y una trampa más, la que costó más tiempo diagnosticar:** esa segunda
> llamada daba **401** aunque la clave fuera correcta. Las API keys de Resend
> tienen dos niveles — *Sending access* (la que recomiendan por defecto) y
> *Full access*— y traer un correo recibido es una operación de lectura que
> exige *Full access*. La clave usada para enviar tenía el nivel por defecto.
> Se sube el permiso de la misma clave en Resend (API Keys → la clave → Full
> access), sin generar una nueva ni tocar Vercel.

## El panel en el teléfono

El CRM se abre desde el celular tanto como desde el escritorio: el asesor
contesta un WhatsApp parado en la obra, no sentado. El panel siempre fue una
página responsive, pero **responsive no es lo mismo que usable con el pulgar**,
y ahí había siete cosas rotas. Corregidas el 2026-09-01, todas dentro de
[`crm/index.html`](crm/index.html):

| Qué pasaba en el teléfono | Qué se hizo |
|---|---|
| Las pestañas se pegaban encima del título o dejaban una franja de fondo | Encabezado y pestañas viajan juntos en `.barra`, una sola caja pegajosa. El `top: 47px` escrito a mano —cierto solo en escritorio— ya no existe |
| La cuarta pestaña, **Alertas**, se cortaba sin señal de que hubiera algo más | La fila rueda de costado, con un desvanecido en el borde derecho que aparece **solo** mientras quede algo por ver, y la pestaña activa se trae sola a la vista |
| Enfocar el campo de escribir **hacía zoom y no lo deshacía**: el panel quedaba corrido el resto de la sesión | Todos los campos a 16 px con puntero grueso, que es el umbral por debajo del cual Safari hace zoom |
| Los botones medían 29 px de alto: se fallan con el dedo | 44 px mínimo (botones, pestañas, filas de la lista, casilla *Atendido*, palanca del bot) en `@media (pointer: coarse)` |
| Con un chat abierto, el botón **Enviar** caía fuera de pantalla y había que hacer scroll de la página para llegar | El hilo ocupa exactamente lo que queda de ventana. El alto lo mide el JS (`ajustarAltoHilo()`), no el CSS: arriba puede haber o no el aviso de recorte, y el encabezado cambia de alto con las etiquetas |
| El aviso de error salía abajo y al centro, **tapando justo el botón Enviar** | En pantalla angosta sale arriba, bajo la barra |
| El campo de escribir medía 44 px fijos: un mensaje de cuatro líneas se redactaba viendo una | Crece con el texto hasta 140 px (240 en correo) |

Y tres cosas menores que solo se notan en un teléfono real: las zonas seguras
del notch y de la barra de inicio (`env(safe-area-inset-*)`, que `viewport-fit=cover`
ya prometía pero nadie cumplía), el scroll de la lista de mensajes que ya no
arrastra la página —ni dispara la recarga por tirón—, y el interruptor del bot,
que caía solo en una tercera fila del encabezado y ahora sube al lado del número.

> [!warning] Un bug que no era de diseño: el panel se quedaba sin sondear
> `Notification.requestPermission()` **lanza** en Safari si no sale de un gesto
> del usuario, y en iOS ni siquiera existe fuera de una app instalada en la
> pantalla de inicio. Estaba sin `try`, y la línea siguiente era
> `arrancarSondeo()`: en iOS la excepción se la llevaba por delante y el panel
> **no volvía a consultar nunca**. Datos congelados en la pantalla, ninguna
> pista de por qué. Hoy va envuelto.

**Con qué se comprobó.** `crm/index.html` no se puede abrir suelto —necesita
`/api/crm`—, así que se probó contra una copia con `fetch` sustituido por datos
de mentira, a 375×812 (iPhone), 768 (tablet) y escritorio: las cuatro pestañas,
el hilo de chat, el de correo y la pantalla de acceso. Sin desbordes
horizontales, sin scroll de página con un hilo abierto, y el escritorio igual
que antes —dos columnas, Enter sigue enviando con teclado físico, que es lo que
espera quien escribe rápido—.

## Puesta en marcha

### 1. Base de datos

Cualquier Postgres gestionado sirve (Neon, Supabase, Vercel Postgres…). El
código usa `pg` y SQL estándar, sin nada específico de un proveedor: si mañana
hay que mudarse, se cambia la URL y ya.

> [!success] Ya aplicadas en la base real el 2026-08-21
> Los seis pasos de abajo están corridos contra el Postgres de producción, y
> comprobados: existen `correos`, `mensajes.wa_id` y los 4 índices nuevos, la
> consulta de teléfonos mal normalizados devolvió **0 filas**, y los 3
> registros reales siguen intactos. Esta sección queda como referencia para
> montar la base desde cero.
>
> **Cómo se corrieron, para que no sorprenda en el historial de git:** las
> variables del proyecto están marcadas *Sensitive* en Vercel, así que
> `vercel env pull` devuelve `[SENSITIVE]` y la cadena de conexión no se puede
> leer desde fuera — la protección funcionando. Se usó un endpoint temporal
> (`api/migracion.js`) que corría el DDL desde dentro, donde `DATABASE_URL` sí
> existe, protegido por un secreto de un solo uso. **Se borró junto con su
> variable en cuanto terminó**; `POST /api/migracion` devuelve 404.

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
5. [`db/bot-2026-08-21.sql`](db/bot-2026-08-21.sql) — la columna `wa_id` y su
   índice único parcial, que es el anti-duplicado del bot. **Sin esto el bot
   falla en cada mensaje**, con *"no unique or exclusion constraint matching
   the ON CONFLICT specification"*. Igual que el anterior: idempotente, y hay
   que correrlo en la base ya creada.
6. [`db/correos-2026-08-21.sql`](db/correos-2026-08-21.sql) — la tabla
   `correos` y sus índices. **Sin esto, la acción `datos` del CRM falla
   entera** (`datos` lee las 5 colecciones en paralelo y una consulta rota
   devuelve 500), así que el panel no carga. Idempotente.

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
| `DATABASE_URL` *(o `POSTGRES_URL`)* | la cadena pooled, con `?sslmode=require` | las tres funciones |
| `CRM_CLAVE` | la clave de acceso al panel | `api/crm.js` |
| `WHATSAPP_TOKEN` | token permanente de la app de Meta | escribir como asesor · el bot |
| `WHATSAPP_PHONE_ID` | id del número emisor (Meta) | escribir como asesor |
| `WHATSAPP_VERIFY_TOKEN` | lo que se quiera, inventado acá | verificar el webhook del bot |
| `WHATSAPP_APP_SECRET` | *App Secret* de la app de Meta | comprobar la firma del bot |
| `ASESOR_WHATSAPP` | *(opcional)* teléfono del asesor, solo dígitos | a dónde deriva el bot |
| `CORREO_API_KEY` | la clave del proveedor de correo | enviar correo |
| `CORREO_REMITENTE` | `Mining Big <gerencia@mining-big.com>` | enviar correo |
| `CORREO_WEBHOOK_SECRET` | inventado acá, se copia en el proveedor | recibir respuestas |
| `CORREO_PROVEEDOR` | *(opcional)* `resend` por defecto | elegir proveedor |
| `CORREO_RESPONDER_A` | *(opcional)* si las respuestas van a otra dirección | `Reply-To` |

`WHATSAPP_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET` son del bot y **hay que
ponerlas antes de configurar el webhook en Meta**:

- `WHATSAPP_VERIFY_TOKEN` es una cadena que se inventa acá y se escribe igual
  en Meta. Solo se usa una vez, en el GET de verificación. Si no está,
  `api/bot.js` responde 500 y Meta no puede dar de alta el webhook — a
  propósito, para que no exista un modo que acepte cualquier verificación.
- `WHATSAPP_APP_SECRET` está en *Configuración de la app → Básica* en el panel
  de Meta. Con ella el bot comprueba la firma `X-Hub-Signature-256` de cada
  POST y **rechaza con 401 lo que no venga de Meta**. Sin ella el bot sigue
  funcionando pero **deja pasar cualquier POST** y escribe
  **rechaza con 401 todos los POST**. Era el pendiente número uno del bot
  viejo, que no tenía forma de validarla.

> [!warning] Sin `WHATSAPP_APP_SECRET` el bot no contesta a nadie
> La primera versión dejaba pasar y avisaba en el log, con el argumento de que
> una variable que falta no debería tumbar la atención al cliente. **Al
> desplegar quedó claro que el argumento no se sostenía:** el endpoint es
> público y adivinable, y sin firma cualquiera puede inyectar mensajes falsos
> que ensucian `mensajes` y `conversaciones`.
>
> Ahora falla al revés, y ese modo de fallo es el benigno: si alguien conecta
> Meta sin poner la variable, el bot no contesta, y eso se ve en el primer
> mensaje de prueba del paso 5. Ruidoso y temprano.

Las de correo se pueden dejar para después **sin romper nada**: sin ellas el
CRM funciona entero y solo el botón de enviar correo responde *"el correo no
está configurado en el servidor"*, que es la verdad. `CORREO_WEBHOOK_SECRET` la
inventás acá y la copiás en la configuración del webhook del proveedor, como
cabecera `x-mb-secreto`.

### Cambiar el número de WhatsApp

> [!success] Migrado el 2026-09-03: **+51 997 013 900**, número completamente nuevo
> No es un traslado del +51 983 582 869 — era una línea nueva sin usar, así
> que se le dio de alta **todo desde cero como número**: entrada en la WABA,
> Phone Number ID propio, registro en la Cloud API. Se confirmó que se agrega
> a la **misma WABA** `1045282521703032` (la del negocio, no una nueva) —
> nada del número anterior se reutilizó.
>
> El botón "Activar verificación en dos pasos" de WhatsApp Manager **no sirve
> como primer paso** — pide registrar la cuenta en la Cloud API primero. Se
> registró con `POST /1340193299172884/register` +
> `{"messaging_product":"whatsapp","pin":"…"}` desde el Graph API Explorer
> (no el cURL que el propio Explorer genera con "Obtener código", que falla
> por poner los parámetros en la query string).
>
> El webhook **no hizo falta tocarlo**: está configurado a nivel app+WABA
> (`https://mining-big.com/api/bot`, campo `messages`), así que un número
> nuevo dentro de la misma WABA cae ahí solo.
>
> **Verificado de punta a punta**: "hola" a +51 997 013 900 → el bot contesta.
> +51 983 582 869 sigue activo en paralelo — decisión pendiente, sin apuro,
> de cuándo desconectarlo.

Esto es **todo** lo que hubo que tocar al cambiar de número — queda
centralizado a propósito para la próxima vez:

| Dónde | Qué | Estado |
|---|---|---|
| Meta · alta del número | agregarlo a la WABA y verificarlo con el código que llega por SMS/llamada | ✅ hecho — Conectado |
| Meta · registro en la Cloud API | `POST /{phone_number_id}/register` con PIN de 6 dígitos (ver arriba) | ✅ hecho |
| Vercel · `WHATSAPP_PHONE_ID` | el *Phone Number ID* nuevo de Meta. **Redeployar después.** | ✅ `1340193299172884` |
| Vercel · `WHATSAPP_TOKEN` | token permanente de *System User* | ✅ cargado |
| Vercel · `WHATSAPP_APP_SECRET` | de la app de Meta — no cambia, misma app/WABA | ✅ no cambia |
| Vercel · `ASESOR_WHATSAPP` | solo si además cambia el teléfono del asesor | ✅ no cambia (`51934747464`) |
| [`index.html`](index.html) · `WHATSAPP_NEGOCIO` | el número del enlace `wa.me` que ve el cliente al registrarse | ✅ `51997013900`, desplegado y verificado en vivo |
| [`index.html`](index.html) · `TELEFONO_VISIBLE` | el que se muestra en el pie (puede ser otro) | ✅ sigue el del asesor |
| Meta · webhook | apuntar `https://mining-big.com/api/bot` al número nuevo y suscribir `messages` | ✅ no requirió cambios — es por WABA, no por número |

> [!warning] El número no puede estar activo en la app de WhatsApp
> La Cloud API rechaza un número que ya tenga cuenta en WhatsApp o WhatsApp
> Business. Si +51 997 013 900 la tiene, hay que **borrar esa cuenta desde la
> app** (Ajustes → Cuenta → Eliminar mi cuenta) antes del alta, y eso se lleva
> el historial de esa cuenta. Si la línea es nueva y sin usar, no hay nada que
> hacer.

<details>
<summary>Histórico: alta del +51 983 582 869 (2026-08-23), número que este cambio reemplaza</summary>

> [!info] Número propio: **+51 983 582 869** — dado de alta el 2026-08-23
> Reemplazó al de prueba de Meta (`15556371888`), que solo escribía a los 5
> destinatarios cargados a mano en la consola y no atendía público real.
> Dado de alta en la WABA `1045282521703032`, Phone Number ID
> `1261469877055727`. El token permanente de System User llegó más tarde,
> bloqueado mientras la WABA estuvo en "Revisión en curso".

</details>

El bot **no** lleva el número emisor escrito en ninguna parte: lo lee del
`phone_number_id` que viene en cada mensaje entrante, así que responde siempre
desde el número que recibió. Eso elimina de raíz la posibilidad de tener un
identificador mal copiado, y es por lo que la lista de arriba es corta.

Dentro de `index.html` los tres datos de contacto viven en **un solo bloque**
al principio del script, y el pie se rellena desde ahí. El HTML del pie trae
igual el valor real escrito, para quien tenga JS desactivado.

Después del cambio, comprobar: registrarse en la landing y que el botón
*Continuar por WhatsApp* abra el número nuevo; escribirle `hola` y que el bot
conteste; y que el pie muestre el teléfono correcto.

Marcarlas para Production, Preview y Development. **Hay que redeployar** después
de agregarlas: las variables se inyectan en el build, no en caliente.

> [!info] Estado al 2026-08-23 (fin de jornada)
> **Puestas y desplegadas:** `DATABASE_URL`, `CRM_CLAVE`, `WHATSAPP_APP_SECRET`,
> `WHATSAPP_PHONE_ID` (`1261469877055727`), `CORREO_WEBHOOK_SECRET` — todas
> *Sensitive*, ninguna legible desde ningún panel una vez guardada.
>
> **`WHATSAPP_VERIFY_TOKEN` se regeneró este mismo día**: el usuario no
> recordaba el valor original y, al estar marcada *Sensitive*, no había forma
> de recuperarlo — ni `vercel env pull` lo expone (`[SENSITIVE]`). En vez de
> perseguirlo, se generó uno nuevo (`openssl rand -hex 24`), se reemplazó en
> Vercel (Production + Preview) y se verificó en vivo contra el dominio: token
> correcto → 200 con el `hub.challenge`; incorrecto → 403. **Ese valor nuevo es
> el que hay que cargar en Meta**, el viejo ya no sirve.
>
> **Falta, y es de cuenta ajena:** `WHATSAPP_TOKEN` — bloqueado, la WABA sigue
> en "Revisión en curso" y no se puede generar el token permanente de System
> User hasta que salga de ahí. También `CORREO_API_KEY` y `CORREO_REMITENTE`
> (proveedor de correo, sin contratar).
>
> El botón *escribir como asesor* del panel sigue sin funcionar en producción
> hasta que llegue `WHATSAPP_TOKEN` — responde "WhatsApp no configurado en el
> servidor", que al menos es honesto.
>
> El número propio +51 983 582 869 está dado de alta en la WABA
> `1045282521703032` desde el 2026-08-23. Ver *Cambiar el número de WhatsApp*.

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
haciendo con la CLI. Con la CLI de Vercel instalada, desde `landing-mining-big/`:

```bash
vercel deploy --prod --yes
```

> [!danger] Verificar que el deploy DE VERDAD llegó
> El 2026-08-31 se descubrió que los deploys llevaban **8 días sin llegar**: la
> CLI **v58.4.4** sobre **Node v24.18.1** revienta de forma intermitente
> (`EPIPE`, `Assertion failed … src\win\async.c` de libuv) **antes de subir los
> archivos**, y cuando pasa **no crea ningún registro de deployment** — parece
> que el comando no hizo nada.
>
> - Antes de nada: `npm i -g vercel@latest` (v59+ maneja Node 24).
> - El deploy tiene que terminar con `Production: https://…` + `● Ready`. Si no,
>   reintentar (el crash es intermitente).
> - Comprobar: `curl -sI https://mining-big.com/` → `age: 0`, y
>   `vercel ls --scope max-2dfa` → el deploy de arriba con edad de segundos.
> - El proyecto en Vercel se llama **`mining-big`** (scope `max-2dfa`), aunque
>   `.vercel/project.json` todavía diga `landing-mining-big`.

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
tres últimas vacías hasta que el bot reciba su primer mensaje. Después, entrar a
`https://mining-big.com/crm/` y comprobar que la pestaña Solicitudes lista los
registros reales y que el check *Atendido* sobrevive a recargar la página.

Repetir la clave mala **once veces seguidas** debe acabar en `429` con
`Retry-After: 300` (tope de intentos fallidos por IP, ver *Pendiente*). No pasa
nada por dispararlo en la verificación: solo bloquea a esa IP y solo durante
cinco minutos, y **únicamente cuenta los fallos** — con la clave correcta se
entra igual.

> [!warning] `vercel.json`: el patrón con `:ruta*` NO cubre la barra final
> Comprobado contra el dominio el 2026-08-21: con solo `"/crm/:ruta*"`, la
> ruta `/crm` traía la CSP y **`/crm/` no traía ninguna cabecera** — y `/crm/`
> es justo la URL que usa el asesor y la que está escrita en la wiki. O sea que
> la CSP no estaba protegiendo nada en la práctica.
>
> Por eso hay **tres** entradas con el mismo bloque: `/crm`, `/crm/` y
> `/crm/:ruta*`. Es feo y es a propósito. Si algún día se agrega una cabecera,
> hay que agregarla en las tres — y volver a comprobar con
> `curl -sI https://mining-big.com/crm/`, con la barra.
>
> Ojo también: `vercel.json` **no admite comentarios** ni propiedades extra. Un
> `"//"` explicativo hace fallar el despliegue entero con *"should NOT have
> additional property"*.

Las cabeceras de `/crm/` las fija [`vercel.json`](vercel.json): `X-Frame-Options`,
`nosniff`, `Referrer-Policy` y una CSP que, entre otras cosas, impide que un
script de la página mande datos a otro dominio (`connect-src 'self'`). Si algún
día el panel necesita cargar algo de fuera —una fuente, una imagen, otra API—,
hay que abrirlo ahí; si no, falla en silencio salvo por la consola.

### 5. Conectar el bot a Meta

Este paso es el último y **no se puede hacer antes de desplegar**: Meta valida
la URL en el momento de guardarla.

Primero, que el endpoint conteste la verificación:

```bash
curl -i "https://mining-big.com/api/bot?hub.mode=subscribe&hub.verify_token=EL_VALOR_DE_WHATSAPP_VERIFY_TOKEN&hub.challenge=12345"
```

Debe devolver `200` con el cuerpo `12345` y nada más. Con un token distinto
debe devolver `403`. Si devuelve `500`, falta la variable de entorno.

Después, en el panel de Meta (*WhatsApp → Configuración → Webhooks → Editar*):

- **URL de devolución de llamada:** `https://mining-big.com/api/bot`
- **Identificador de verificación:** el mismo valor de `WHATSAPP_VERIFY_TOKEN`
- Suscribirse al campo **`messages`**.

Y comprobar que la cuenta está suscrita a la app correcta (ver *Cuando Meta
entrega y no llega nada*, más arriba). Con eso, escribirle al número desde un
teléfono autorizado:

| Se manda | Debe pasar |
|---|---|
| `hola` | contesta el menú |
| `4` | contesta tarifas |
| `cuanto cuesta un volquete` | contesta **tarifas**, no el catálogo |
| `asdfgh` | contesta "No entendí" + el menú |
| `5` | contesta con el enlace al asesor **y aparece una alerta en el CRM** |
| cualquiera de los anteriores | el hilo aparece en la pestaña **Chats** del panel |
| apagar el bot en el panel y escribir | **no** contesta, pero el mensaje se registra igual |

Y en los logs de la función, que **no** aparezca
`bot: ATENCION — sin WHATSAPP_APP_SECRET`. Si aparece, la firma no se está
comprobando.

### 6. Conectar el correo — hecho el 2026-09-02, dejado acá por si hay que rehacerlo

1. En Resend, **Add Domain** → `mining-big.com` (el dominio raíz — el envío se
   verifica ahí; no rompe nada porque Resend usa un subdominio propio,
   `send.mining-big.com`, para el bounce/SPF, y otro, `resend._domainkey`,
   para el DKIM). `CORREO_API_KEY` y `CORREO_REMITENTE` ya están en Vercel.
2. **Para recibir hace falta un segundo dominio, aparte.** Resend solo deja
   activar "Enable Receiving" apuntando el **MX del `@` del dominio que
   verificaste** — si ese dominio es la raíz, pide reemplazar el MX de
   Microsoft 365 (Resend mismo avisa: *"Routing emails to Resend will disable
   old MX records. Use a subdomain to avoid issues."*). Se agregó
   `responde.mining-big.com` como dominio **separado** en Resend, se verificó
   con sus propios DKIM/SPF, y ahí sí se activó "Enable Receiving" — su MX no
   compite con nada.
3. `CORREO_RESPONDER_A` = `respuestas@responde.mining-big.com`, cargada en
   Vercel, para que las respuestas vayan al dominio que puede recibirlas sin
   que el cliente vea la diferencia.
4. En Resend, **Webhooks** → **Add Endpoint** → `https://mining-big.com/api/correo`,
   evento `email.received`. El *signing secret* (`whsec_...`) que entrega va en
   `CORREO_WEBHOOK_SECRET`.
5. **La clave necesita permiso "Full access" en Resend**, no el "Sending
   access" que se elige por defecto — traer el cuerpo de un correo recibido es
   una lectura, y con permiso solo de envío la API de recepción devuelve 401.
   Se cambia en API Keys → la clave → el nivel, sin generar una nueva.
6. Probar de punta a punta: enviar desde el panel a una dirección propia,
   responder ese correo, y confirmar que la respuesta aparece en el hilo **con
   el texto**, no solo el asunto — el webhook de Resend no manda el cuerpo, así
   que si aparece vacío es la trampa de arriba (*firma verificada, payload
   confirmado*), no un problema de conexión.

## Pendiente

- ~~**La entrada de correo no está verificada contra un proveedor real.**~~
  **Resuelto el 2026-09-02.** Firma Svix, formato del payload y la llamada a
  la API de recepción de Resend, todo confirmado contra correos reales
  enviados y recibidos de punta a punta. Detalle de los tres tropiezos reales
  —dominio raíz vs. subdominio para recibir, el webhook sin cuerpo, el permiso
  de la API key— en *Correo* más arriba y en [[crm-mining-big]].
- **El bot está sin desplegar y sin conectar a Meta.** El código está y está
  probado, pero no ha visto un mensaje real. Hasta el paso 5 de *Puesta en
  marcha*, dos de las tres pestañas del CRM siguen vacías y nadie contesta a
  los clientes.
- **El número de WhatsApp sigue siendo el de prueba de Meta**: escribe solo a
  los 5 destinatarios cargados a mano en la consola, y el token que muestra esa
  consola dura 24 h (hace falta uno permanente de *System User*). Para atender
  público real hay que registrar un número propio y verificar el negocio — lo
  que exige dominio propio, que ya está.
- **La clave del CRM sigue siendo un secreto compartido** que viaja en el body
  y vive en `localStorage`. No hay usuarios ni roles. Alcanza para un asesor;
  si entra un segundo, hace falta login de verdad.
- **El tope de `/api/registro` también es por instancia**: 5 registros
  guardados por IP en 10 minutos, desde el 2026-08-21. Solo cuentan los que se
  guardaron, así que un cliente que se equivoca en el correo y reintenta no
  gasta cupo. Contra un bot distribuido no alcanza: para eso, captcha.
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
- **Avisos al asesor**: sigue sin haber aviso *automático* cuando entra una
  solicitud o una alerta — el panel avisa solo si está abierto. Con el correo
  ya conectado, engancharlo es escribir un `enviarCorreo()` en
  `api/registro.js`; no se hizo porque hay que decidir a qué dirección y con
  qué frecuencia, para no convertirlo en ruido.
- **El hilo de correo se agrupa por dirección, no por `In-Reply-To`.** Si el
  cliente contesta desde otra dirección, abre un hilo nuevo. Es lo mismo que
  hace WhatsApp con un teléfono distinto, y arreglarlo de verdad pide seguir la
  cadena de `References`.
