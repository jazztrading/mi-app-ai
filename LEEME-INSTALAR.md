# Cómo subir estos cambios a GitHub

Este paquete lo incluye TODO (podcasts, YouTube, fotos, lenguaje sencillo, webs que bloquean, cuota de búsqueda).
No hace falta aplicar los zips anteriores: este los sustituye.

Son 15 archivos. Debes subirlos **con sus carpetas**:

    server.ts
    .env.example
    src/App.tsx
    server/audit.ts  citations.ts  grounding.ts  media.ts  pageAccess.ts  safeFetch.ts  security.ts
    tests/audit.test.ts  audit-batch.test.ts  citations.test.ts  media.test.ts  pageAccess.test.ts

## Pasos (desde la web de GitHub)
1. Descomprime el zip (en Windows: clic derecho > «Extraer todo»).
2. Abre la carpeta `lupa-critica-TODO`. Sube lo que hay DENTRO, no la carpeta `lupa-critica-TODO` en sí.
3. En tu repositorio: «Add file» > «Upload files». Arrastra `server.ts`, `.env.example` y las carpetas `src`, `server` y `tests`.
   Comprueba que GitHub muestra las rutas completas (por ejemplo `server/audit.ts`).
   Si no ves `.env.example`, no pasa nada: solo es documentación.
4. Abajo, en «Commit changes»: escribe un mensaje (por ejemplo «Podcasts, lenguaje sencillo y cuota de búsqueda»).
   Más seguro: elige «Create a new branch» y abre un «Pull request»; mira la pestaña «Files changed» y pulsa «Merge».
5. Render (o Vercel) vuelve a desplegar solo. Espera a que termine.

## Qué comprobar después
- Abre la web y analiza un texto corto.
- En Render > Logs deben aparecer, al comprobar datos, líneas `[Gemini Grounded Batch]`.
- Si algo va mal: en GitHub, abre el commit y pulsa «Revert». Vuelve todo a como estaba.

## Importante
- No subas `node_modules`, `dist` ni tu clave `GEMINI_API_KEY`. La clave solo va en las variables de entorno de Render.
- Sube estos archivos encima de los que ya tienes: no borres nada.
