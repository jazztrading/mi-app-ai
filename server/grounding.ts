// Búsqueda con Google agrupada: una sola petición verifica varias afirmaciones.
//
// Antes se hacía una petición por afirmación (y cada fallo se reintentaba en tres modelos). Con las cuentas
// gratuitas de Gemini, que tienen muy pocas peticiones al día, un informe de 7 afirmaciones agotaba la cuota.
// Aquí se agrupan hasta N afirmaciones por petición. Para no perder el rigor, las fuentes se reparten por
// afirmación usando los «groundingSupports» de Gemini (qué fragmento de la respuesta apoya cada fuente):
// una afirmación solo recibe las fuentes que respaldan SU sección, nunca las de otra.

export interface BatchItem {
  id: string;
  question: string;
}

export interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

export interface GroundingSupport {
  segment?: { startIndex?: number; endIndex?: number; text?: string };
  groundingChunkIndices?: number[];
}

export interface SectionEvidence {
  text: string;
  sources: Array<{ title: string; url: string }>;
}

export function buildBatchPrompt(items: BatchItem[]): string {
  const list = items.map((it) => `[${it.id}] ${it.question}`).join("\n");
  return `Verifica de forma independiente cada una de estas preguntas de comprobación de hechos.

${list}

Instrucciones:
- Responde una sección por pregunta, en el mismo orden. Cada sección empieza con una línea que contiene SOLO el marcador, por ejemplo:
### [${items[0]?.id ?? "c1"}]
y a continuación la respuesta de esa pregunta (sin mezclar datos de unas preguntas con otras).
- En cada sección, responde únicamente con lo que establecen fuentes fiables (organismos oficiales, bases de datos oficiales, publicaciones revisadas por pares, prensa de referencia).
- Empieza por el HECHO tal como lo establecen las fuentes, con nombres, fechas y cifras exactas.
- Si las fuentes no permiten responder con seguridad, o se contradicen, escribe EVIDENCIA INSUFICIENTE en esa sección y explica qué falta.
- No asumas que ninguna afirmación previa sea cierta. No escribas URLs: las fuentes se registran aparte.`;
}

interface Range {
  id: string;
  start: number; // inicio del contenido de la sección (tras la línea del marcador)
  end: number;
}

/** Localiza las secciones «### [id]» en el texto. Devuelve rangos de caracteres. */
export function findSections(text: string, ids: string[]): Range[] {
  const re = /^[ \t]*#{2,4}[ \t]*\[?\s*(c\d+)\s*\]?[ \t]*:?[ \t]*$/gim;
  const marks: Array<{ id: string; markerStart: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (ids.includes(m[1].toLowerCase())) marks.push({ id: m[1].toLowerCase(), markerStart: m.index, contentStart: m.index + m[0].length });
  }
  return marks.map((mk, i) => ({ id: mk.id, start: mk.contentStart, end: i + 1 < marks.length ? marks[i + 1].markerStart : text.length }));
}

/** Los índices de Gemini son bytes UTF-8; se pasan a posiciones de carácter. */
function byteToCharIndex(text: string, byteIdx: number): number {
  return Buffer.from(text, "utf8").subarray(0, byteIdx).toString("utf8").length;
}

function segmentPosition(text: string, seg: NonNullable<GroundingSupport["segment"]>): number {
  const hint = typeof seg.startIndex === "number" ? byteToCharIndex(text, seg.startIndex) : -1;
  if (seg.text) {
    if (hint >= 0 && text.startsWith(seg.text, hint)) return hint;
    const idx = text.indexOf(seg.text);
    if (idx >= 0) return idx;
  }
  return hint;
}

/**
 * Reparte la respuesta agrupada en secciones y asigna a cada una solo las fuentes cuyo fragmento de apoyo cae dentro de ella.
 * Una sección ausente o vacía no aparece en el resultado (quien llama la trata como fallo, no como «sin evidencia»).
 */
export function parseBatchResponse(
  text: string,
  ids: string[],
  chunks: GroundingChunk[] | undefined,
  supports: GroundingSupport[] | undefined
): Record<string, SectionEvidence> {
  const ranges = findSections(text, ids);
  const out: Record<string, SectionEvidence> = {};
  for (const r of ranges) {
    const body = text.slice(r.start, r.end).trim();
    if (body) out[r.id] = { text: body, sources: [] };
  }
  const webChunks = Array.isArray(chunks) ? chunks : [];
  for (const sup of Array.isArray(supports) ? supports : []) {
    if (!sup?.segment || !Array.isArray(sup.groundingChunkIndices)) continue;
    const pos = segmentPosition(text, sup.segment);
    if (pos < 0) continue;
    const range = ranges.find((r) => pos >= r.start && pos < r.end);
    if (!range || !out[range.id]) continue;
    for (const ci of sup.groundingChunkIndices) {
      const web = webChunks[ci]?.web;
      if (!web?.uri) continue;
      if (!out[range.id].sources.some((s) => s.url === web.uri)) {
        out[range.id].sources.push({ title: web.title || "Fuente consultada", url: web.uri });
      }
    }
  }
  return out;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
