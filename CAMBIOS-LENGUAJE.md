# Lupa Crítica · Lenguaje sencillo (nivel bachillerato)

## Qué se ha cambiado
1. **Interfaz (`src/App.tsx`)**: 295 textos reescritos: botones, títulos, explicaciones, pasos de carga, avisos, ventanas de confirmación y la exportación a Notion. Ejemplos: «Iniciar Desglose Crítico» → «Analizar»; «Histórico» → «Historial»; «Gabinete» → «Panel / Todo listo»; «Contraargumentación rigurosa» → «Argumentos en contra»; «Perímetro de las cifras» → «Qué incluyen las cifras».
2. **Lo que escribe la IA en cada análisis (`server.ts`)**: la IA ya no se presenta como «catedrático universitario». Ahora recibe un bloque «NIVEL DE LENGUAJE»: frases cortas, palabras comunes, términos técnicos explicados entre paréntesis, ejemplos cotidianos y una lista de palabras rebuscadas con su alternativa. El mismo criterio se aplica al resumen, glosario, críticas, debates, correcciones y cambio de idioma (castellano, gallego y catalán).
3. **Auditoría y citas (`server/audit.ts`, `server/citations.ts`)**: explicaciones de cada afirmación, informe de comprobación y razones de la nota de fiabilidad.
4. **Mensajes de error (`server.ts`, `server/security.ts`)**: más claros y sin jerga («Rate Limit / Quota», «fichero», etc.).
5. **Tests**: se actualizan 3 frases esperadas (`tests/audit.test.ts`, `tests/citations.test.ts`).

## Qué NO cambia
Las reglas de rigor (no inventar citas, comprobar fuentes, mismo listón para todo), los nombres de campos y la estructura de datos. Se simplifican las palabras, no el contenido.

## Cómo aplicarlo
Copia los archivos de esta carpeta sobre tu repo (respetando rutas). Incluye también los cambios de podcasts/YouTube/fotos del paquete anterior: si ya los aplicaste, estos archivos los sustituyen. Si prefieres un parche solo de lenguaje: `git apply solo-lenguaje.patch`. Después `npm test`, `npm run build`, commit y push.

## Pendiente / decisiones tuyas
- La nota «Contexto oficial comprobado» (pensiones, en `server/knowledge.ts`) es texto escrito a mano con matices legales. No la he tocado para no cambiar su sentido; si quieres, la reescribo y la revisas.
- Los textos de la auditoría en gallego y catalán (`server/audit.ts`) y los de la interfaz en gallego se han simplificado menos que los de castellano: conviene que alguien con buen nivel de gallego y catalán los revise.
- La interfaz mezcla castellano y gallego (panel de auditoría y de corrección). No lo he unificado porque no lo pediste.
- Los análisis ya guardados conservan su redacción antigua. Para ver el nuevo estilo hay que analizar de nuevo con «Reanalizar desde cero».
