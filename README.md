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

## Pendiente

El formulario de registro **no persiste los datos todavía**. Valida en el cliente
y muestra una confirmación con folio, pero no envía nada a ningún servidor.
Para que capte registros de verdad hay que apuntar el `submit` a un endpoint
(webhook de n8n, Formspree, o una función serverless en `api/`).

Los datos de flota, teléfono y correo del pie son de ejemplo y hay que
reemplazarlos por los reales antes de difundir el enlace.
