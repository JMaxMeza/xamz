# /xamz — vista previa de XAMZ en mining-big.com

`marketing-ventas/index.html` es una **copia** del demo clickeable de XAMZ.
Fuente canónica: `../../xamz/demo/marketing-ventas.html` (en la raíz del vault).

Es el prototipo con datos de ejemplo en `localStorage`, **no** la app real
multiempresa de `../../xamz/`. Se publicó acá "por mientras para visualizar",
con el mismo patrón que `/crm`.

**Si tocás el demo canónico, re-copiá:**

```bash
cp "../../xamz/demo/marketing-ventas.html" "marketing-ventas/index.html"
vercel --prod
```

Headers/CSP para `/xamz/:ruta*` están en `../vercel.json` (permite Google Fonts).
