# Lupa Crítica · Podcasts, YouTube y fotos

## Qué cambia

| Entrada | Antes | Ahora |
|---|---|---|
| **Podcast (URL de la página del episodio)** | Se analizaban solo las notas de la web (en El Panóptico 5x01, ~2 min de lectura). El audio no se oía. | Se localiza el archivo de audio en la página, se descarga a disco (con las defensas anti-SSRF) y Gemini lo transcribe con marcas de tiempo `[MM:SS]` y etiquetas de voz. Después se resume y se critica como cualquier artículo. |
| **URL directa a un .mp3/.m4a** | El scraper leía los bytes como si fueran HTML. | Se transcribe directamente. |
| **YouTube** | Subtítulos con `youtube-transcript`; si fallaban, el prompt decía «es un tutorial sin voz» y el modelo analizaba solo por el título. | Subtítulos → si faltan o son mínimos, Gemini procesa el vídeo público por URL. Si todo falla, el aviso al modelo es explícito («no inventes el contenido») y el análisis no se congela. |
| **Fotos** | Las imágenes viajaban dentro de la llamada de análisis: sin texto que revisar, auditar ni reutilizar. | Paso OCR previo con transcripción literal (`[ilegible]`, `[?]`); el texto se ve, se audita y permite reutilizar el análisis. Si el OCR no obtiene texto, vuelve al comportamiento anterior. |
| **Comentarios de WordPress** | Entraban como si fueran texto del autor. | Se eliminan (`#comments`, `.comment-list`, `#respond`…). |

Cada transcripción lleva `transcriptInfo`: origen (audio / vídeo / subtítulos / OCR / solo notas), si está completa, modelo y número de pasadas. La interfaz muestra una tarjeta «Transcripción» con copiar y descargar .txt, una insignia de origen y un aviso si puede estar incompleta. La exportación a Notion incluye la transcripción.

## Archivos
- `server/media.ts` (nuevo): localizar audio, descargar, transcribir (audio, YouTube, fotos), avisos al modelo.
- `server/safeFetch.ts`: añade `safeDownload` (descarga binaria a disco, mismas defensas anti-SSRF y tope de bytes).
- `server.ts`: engancha lo anterior en `/api/analyze`.
- `src/App.tsx`: tarjeta de transcripción, pasos de carga y exportación.
- `tests/media.test.ts` (nuevo): 11 tests.
- `.env.example`: variables opcionales nuevas.

## Cómo aplicarlo
Copia los archivos de esta carpeta sobre tu repo (respetando rutas), o desde la raíz del repo: `git apply medios-podcast-youtube-fotos.patch`. Después: `npm test`, `npm run build`, commit y push; Render redespliega.

## Variables opcionales
`MAX_AUDIO_MB` (120) · `AUTO_TRANSCRIBE=false` · `YOUTUBE_AI_TRANSCRIPT=false` · `OCR_PREPASS=false`

## Qué NO se ha podido probar (hazlo tú con la clave real)
1. La llamada real a Gemini con audio, YouTube y fotos: aquí no hay acceso a la API. Los tests usan un Gemini simulado.
2. Que el `.m4a` de El Panóptico se acepte: la documentación de Gemini lista oficialmente mp3, aac, ogg, wav, flac y aiff; m4a aparece en otras tablas. El código prueba `audio/m4a` → `audio/mp4` → `audio/aac`.
3. La detección del audio sobre el HTML real de la página (los tests usan una reconstrucción de su estructura).

## Límite conocido: duración de la petición
La transcripción se hace dentro de `/api/analyze`, que es síncrona. Un episodio de 1 h puede tardar varios minutos. Si el proxy de tu host corta peticiones largas, verás un error aunque el servidor siga trabajando. La solución es pasar a trabajos asíncronos con sondeo (siguiente paso recomendado).
