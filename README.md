# Mining Big — landing de registro

Landing page estática para captar registros de clientes de alquiler de maquinaria
pesada (excavadoras, volquetes, cargadores, perforadoras, etc.).

Un solo archivo, sin dependencias ni build: [`index.html`](index.html) lleva el
HTML, el CSS y el JS embebidos.

## Desplegar en Vercel

1. Crear un repositorio vacío en GitHub (sin README, sin .gitignore).
2. Conectarlo y subir:

   ```bash
   git remote add origin https://github.com/USUARIO/REPO.git
   git push -u origin main
   ```

3. Entrar a https://vercel.com/new, importar el repositorio.
4. En la configuración del proyecto dejar **Framework Preset: Other** y no tocar
   los comandos de build ni el directorio de salida. Es un sitio estático puro.
5. Deploy.

Cada `git push` a `main` vuelve a desplegar automáticamente.

## Captura de registros

El formulario **sí persiste los datos**. Hace `POST` a un webhook de n8n:

```
https://m4xx.app.n8n.cloud/webhook/registro-mining-big
```

La URL está en la constante `ENDPOINT_REGISTRO`, arriba del `<script>`.

El **folio lo genera el servidor** y vuelve en la respuesta — el que ve el
cliente es el mismo que queda guardado en la base. Si el envío falla, la landing
muestra un mensaje de error y **no** muestra folio: prometer un registro que no
se guardó sería peor que fallar de forma visible.

Los registros van a la data table `registros_mining_big` de n8n, con el campo
`atendido` en `false` para poder filtrar los pendientes.

## Pendiente

Los datos de flota, teléfono y correo del pie son de ejemplo y hay que
reemplazarlos por los reales antes de difundir el enlace.

El webhook es **público y sin autenticación**. Si empieza a llegar spam, hay que
activar Header Auth en el nodo Webhook y mandar la cabecera desde la landing.
