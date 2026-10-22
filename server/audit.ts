// Fase 1b · Auditoría afirmación por afirmación.
//
// Por qué existe: la auditoría anterior le pedía a un LLM un "dictamen" global sobre el RESUMEN que ese mismo
// LLM había escrito, con una única búsqueda genérica, y solo podía responder "verified" (todo 100 % exacto) o
// "corrected". Un error del artículo que no sobrevivía al resumen era invisible.
//
// Diseño:
//  1. Extraer afirmaciones atómicas del TEXTO ORIGINAL (sin juzgarlas todavía).
//  2. Buscar evidencia para cada una con una pregunta NEUTRAL (el buscador no ve la afirmación del autor).
//  3. Juzgar afirmación vs. evidencia con el mismo rasero, tanto si coinciden como si no.
//  4. Reglas deterministas (código, no LLM) que impiden sellos sin fuentes reales y confianza inflada.
//  5. El dictamen se construye por plantilla a partir de los recuentos, nunca con prosa libre del LLM.
import { Type } from "@google/genai";

export type ClaimVerdict = "supported" | "contradicted" | "partially_supported" | "insufficient_evidence" | "not_checkable";
export type ClaimType = "fact" | "quantitative" | "attribution" | "prediction" | "opinion";

export interface ClaimCheck {
  id: string;
  claim: string; // afirmación atómica y autocontenida
  quote: string; // fragmento literal del texto auditado ("" si no se pudo localizar)
  quoteLocated: boolean; // true solo si el fragmento aparece realmente en el texto
  claimType: ClaimType;
  verdict: ClaimVerdict;
  confidence: number; // 0.0-1.0, ya acotada por las reglas deterministas
  explanation: string;
  correction?: string;
  evidenceQuote?: string; // frase corta literal de la evidencia que sostiene el veredicto
  evidence: Array<{ title: string; url: string }>; // solo fuentes reales devueltas por el buscador
  searchFailed?: boolean; // la búsqueda falló técnicamente: NO equivale a "no hay evidencia"
  neutralQuestion?: string; // se guarda para poder volver a auditar EXACTAMENTE las mismas afirmaciones
  importance?: number;
}

export interface AuditDeps {
  llmJson: (prompt: string, system: string, schema: any) => Promise<string>;
  groundedSearch: (prompt: string) => Promise<{ text: string; sources: Array<{ title: string; url: string }>; failed?: boolean; error?: string }>;
}

export interface AuditInput {
  title: string;
  lang: string; // "castellano" | "galego" | "català" | otro
  sourceText?: string; // texto original del artículo, si existe
  summary: string;
  keyPoints: string[];
}

export interface AuditOutcome {
  claimChecks: ClaimCheck[];
  counts: Record<ClaimVerdict, number>;
  coverage: { extracted: number; considered: number; searched: number; notCheckable: number; textTruncated: boolean; maxClaims: number; searchFailed: number; quota?: "day" | "minute"; claimsReused?: boolean };
  auditedFrom: "original_text" | "summary_only";
  status: "verified" | "corrected" | "inconclusive";
  summaryAudit: string;
  verdictTitle: string;
  verifiedSources: Array<{ title: string; url: string }>;
  strongCorrections: string[];
}

export const AUDIT_MAX_CLAIMS = Math.max(1, Number(process.env.AUDIT_MAX_CLAIMS) || 10);
export const AUDIT_CONCURRENCY = 2;
const DEFAULT_RETRY_DELAY_MS = 4000;
export const AUDIT_TEXT_CAP = 60_000;
const MIN_SOURCE_TEXT = 200;
const VERDICTS: ClaimVerdict[] = ["supported", "contradicted", "partially_supported", "insufficient_evidence", "not_checkable"];
const CLAIM_TYPES: ClaimType[] = ["fact", "quantitative", "attribution", "prediction", "opinion"];

// ── utilidades ───────────────────────────────────────────────────────────────
export function normalizeForMatch(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** true solo si `fragment` aparece realmente en `text` (ignora mayúsculas, acentos y puntuación). */
export function locateFragment(fragment: string, text: string): boolean {
  const f = normalizeForMatch(fragment);
  if (f.length < 12) return false;
  return normalizeForMatch(text).includes(f);
}

function parseJson(raw: string): any {
  const cleaned = (raw || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

const clamp01 = (n: any) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const words = (s: string) => (s || "").trim().split(/\s+/).filter(Boolean);
const clip = (s: any, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 1. extracción de afirmaciones ────────────────────────────────────────────
interface RawClaim {
  claim: string;
  quote: string;
  claimType: ClaimType;
  neutralQuestion: string;
  importance: number;
}

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING, description: "Afirmación atómica y autocontenida, comprensible sin el resto del texto." },
          quote: { type: Type.STRING, description: "Fragmento LITERAL del texto (máx. 30 palabras) donde se hace la afirmación. Copia exacta, sin parafrasear." },
          claimType: { type: Type.STRING, enum: CLAIM_TYPES, description: "fact | quantitative | attribution (quién dijo/hizo qué) | prediction | opinion" },
          neutralQuestion: { type: Type.STRING, description: "Pregunta abierta y neutra que un buscador podría responder, SIN contener la respuesta que da el autor." },
          importance: { type: Type.INTEGER, description: "1-5: cuánto importa para la tesis y cuánto daño haría si fuera falsa." },
        },
        required: ["claim", "quote", "claimType", "neutralQuestion", "importance"],
      },
    },
  },
  required: ["claims"],
};

async function extractClaims(deps: AuditDeps, text: string, lang: string): Promise<RawClaim[]> {
  const system = `Eres un analista que extrae afirmaciones verificables de un texto. NO juzgas si son verdaderas: eso se hace después.
Reglas:
- Extrae afirmaciones atómicas (una idea comprobable por afirmación): hechos, cifras, fechas, premios, cargos, atribuciones ("X dijo/escribió/hizo Y"), citas, relaciones causales con datos.
- Incluye las afirmaciones tanto si parecen plausibles como si parecen dudosas. No descartes una por sonar bien.
- Marca como "opinion" los juicios de valor y como "prediction" lo que se refiere al futuro; no los conviertas en hechos.
- "quote" debe ser copia LITERAL del texto. Si no puedes copiarla literalmente, déjala vacía antes que parafrasear.
- "neutralQuestion" no debe contener la respuesta del autor (p. ej. no "¿Ganó Hassabis el Nobel de Medicina?", sino "¿Qué premio Nobel recibió Demis Hassabis y en qué año?").
- Escribe "claim" y "neutralQuestion" en ${lang}.
- Si el texto no contiene afirmaciones comprobables, devuelve una lista vacía.`;
  const prompt = `Texto a analizar:\n"""\n${text}\n"""\n\nDevuelve las afirmaciones verificables en el JSON indicado.`;
  const parsed = parseJson(await deps.llmJson(prompt, system, extractionSchema));
  const list: any[] = Array.isArray(parsed?.claims) ? parsed.claims : [];
  return list
    .filter((c) => c && typeof c.claim === "string" && c.claim.trim().length > 5)
    .map((c) => ({
      claim: clip(c.claim, 400),
      quote: clip(c.quote, 400),
      claimType: (CLAIM_TYPES.includes(c.claimType) ? c.claimType : "fact") as ClaimType,
      neutralQuestion: clip(c.neutralQuestion, 400),
      importance: Math.min(5, Math.max(1, Math.round(Number(c.importance) || 3))),
    }));
}

// ── 2. evidencia (a ciegas respecto a la afirmación del autor) ───────────────
export interface GeminiErrorInfo {
  message: string;
  code?: number;
  status?: string;
  quotaId?: string;
  model?: string;
  retryAfterSec?: number;
  quota?: "day" | "minute" | "other"; // solo si es un error de cuota (429)
}

/** Extrae de un error de Gemini (JSON, a veces con texto delante) el mensaje, la cuota afectada y cuándo reintentar. */
export function parseGeminiError(raw: any): GeminiErrorInfo {
  const text: string = typeof raw === "string" ? raw : raw?.message || "";
  let j: any = null;
  for (const candidate of [text, text.slice(Math.max(0, text.indexOf("{")))]) {
    try {
      j = JSON.parse(candidate);
      break;
    } catch {
      /* probar la siguiente */
    }
  }
  const err = j?.error;
  const info: GeminiErrorInfo = { message: String(err?.message || text) };
  if (err) {
    info.code = typeof err.code === "number" ? err.code : undefined;
    info.status = typeof err.status === "string" ? err.status : undefined;
    for (const d of Array.isArray(err.details) ? err.details : []) {
      const v = Array.isArray(d?.violations) ? d.violations[0] : null;
      if (v) {
        if (typeof v.quotaId === "string") info.quotaId = v.quotaId;
        if (typeof v.quotaDimensions?.model === "string") info.model = v.quotaDimensions.model;
      }
      if (typeof d?.retryDelay === "string") {
        const n = parseFloat(d.retryDelay);
        if (Number.isFinite(n)) info.retryAfterSec = n;
      }
    }
  }
  const is429 = info.code === 429 || info.status === "RESOURCE_EXHAUSTED" || /\b429\b|RESOURCE_EXHAUSTED/.test(text);
  if (is429) {
    if (/PerDay/i.test(info.quotaId || "") || /per day/i.test(info.message)) info.quota = "day";
    else if (/PerMinute/i.test(info.quotaId || "") || /per minute/i.test(info.message)) info.quota = "minute";
    else info.quota = "other";
  }
  return info;
}

/** Mensaje de error corto y sin secretos, apto para mostrar al usuario. */
export function sanitizeError(raw: any): string {
  const info = parseGeminiError(raw);
  let msg = info.message.replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[clave]").replace(/\s+/g, " ").trim();
  const dot = msg.indexOf(". ");
  if (info.quota && dot > 0) msg = msg.slice(0, dot); // primera frase: el resto es enlaces
  msg = msg.slice(0, 160);
  const extra: string[] = [];
  if (info.quotaId) extra.push(`cuota: ${info.quotaId}`);
  if (info.model) extra.push(`modelo: ${info.model}`);
  if (info.quota === "day") extra.push("límite diario: se reinicia a medianoche, hora del Pacífico");
  else if (info.quota === "minute") extra.push("límite por minuto");
  if (info.retryAfterSec !== undefined) extra.push(`reintentar en ~${Math.ceil(info.retryAfterSec)} s`);
  return (extra.length ? `${msg} [${extra.join(" · ")}]` : msg).slice(0, 320) || "error desconocido";
}

interface Evidence {
  text: string;
  sources: Array<{ title: string; url: string }>;
  failed: boolean;
  error?: string;
  quota?: "day" | "minute" | "other";
  retryAfterSec?: number;
}

async function searchEvidence(deps: AuditDeps, question: string): Promise<Evidence> {
  const prompt = `Pregunta de verificación: ${question}

Instrucciones:
- Responde únicamente con lo que establecen fuentes fiables (organismos oficiales, comités o bases de datos oficiales, publicaciones revisadas por pares, prensa de referencia).
- Empieza por el HECHO tal como lo establecen las fuentes, con nombres, fechas y cifras exactas.
- Si las fuentes no permiten responder con seguridad, o se contradicen entre sí, escribe EVIDENCIA INSUFICIENTE y explica qué falta.
- No asumas que ninguna afirmación previa sea cierta. No escribas URLs: las fuentes se registran aparte.`;
  try {
    const r = await deps.groundedSearch(prompt);
    if (r.failed) {
      const info = parseGeminiError(r.error || "el buscador no respondió");
      return { text: "", sources: [], failed: true, error: sanitizeError(r.error || "el buscador no respondió"), quota: info.quota, retryAfterSec: info.retryAfterSec };
    }
    const text = (r.text || "").slice(0, 2500);
    if (!text.trim()) return { text: "", sources: [], failed: true, error: "respuesta vacía del buscador" };
    return { text, sources: r.sources || [], failed: false };
  } catch (e: any) {
    const info = parseGeminiError(e);
    return { text: "", sources: [], failed: true, error: sanitizeError(e), quota: info.quota, retryAfterSec: info.retryAfterSec };
  }
}

// ── 3. juicio afirmación vs. evidencia ───────────────────────────────────────
const judgeSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          verdict: { type: Type.STRING, enum: ["supported", "contradicted", "partially_supported", "insufficient_evidence"] },
          confidence: { type: Type.NUMBER, description: "0.0-1.0 calibrada." },
          explanation: { type: Type.STRING, description: "Máximo 2 frases: qué dice la evidencia frente a la afirmación." },
          correction: { type: Type.STRING, description: "Dato correcto según la evidencia. Vacío si la afirmación está respaldada o no hay evidencia." },
          evidenceQuote: { type: Type.STRING, description: "Frase corta LITERAL copiada del texto de evidencia que sostiene el veredicto. Vacío si no hay." },
        },
        required: ["id", "verdict", "confidence", "explanation"],
      },
    },
  },
  required: ["results"],
};

async function judgeClaims(deps: AuditDeps, items: Array<{ id: string; claim: string; evidence: string; nSources: number }>, lang: string) {
  const system = `Eres un verificador de hechos riguroso e imparcial. Comparas cada afirmación con la evidencia recuperada.
Reglas (el mismo rasero para todas las afirmaciones, coincidan o no con la evidencia):
- "supported": la evidencia afirma EXPLÍCITAMENTE lo mismo. Que suene plausible o que tú lo recuerdes NO basta.
- "contradicted": la evidencia afirma EXPLÍCITAMENTE algo incompatible (otro premio, otra fecha, otra cifra, otra persona). Indica el dato correcto en "correction".
- "partially_supported": parte correcta y parte imprecisa o exagerada.
- "insufficient_evidence": la evidencia dice EVIDENCIA INSUFICIENTE, está vacía, es vaga o no trata el punto. Es una respuesta legítima y preferible a adivinar.
- Antes de decidir, pregúntate: "¿exigiría el mismo nivel de prueba si la afirmación fuera la contraria?".
- Usa solo el texto de evidencia dado, no tu memoria.
- Confianza calibrada: 0.9-1.0 solo con evidencia explícita, precisa y de fuentes autorizadas; 0.7-0.89 evidencia clara; 0.4-0.69 indirecta o parcial; menos de 0.4 débil. No infles.
- "evidenceQuote" debe ser copia literal y corta (máx. 25 palabras) del texto de evidencia, o vacío.
- Redacta "explanation" y "correction" en ${lang}.`;
  const body = items
    .map((it) => `ID: ${it.id}\nAFIRMACIÓN: ${it.claim}\nFUENTES REALES RECUPERADAS: ${it.nSources}\nEVIDENCIA:\n${it.evidence || "(vacía)"}`)
    .join("\n\n=====\n\n");
  const parsed = parseJson(await deps.llmJson(`Juzga cada afirmación:\n\n${body}`, system, judgeSchema));
  return Array.isArray(parsed?.results) ? parsed.results : [];
}

// ── 4. reglas deterministas ──────────────────────────────────────────────────
export function applyGuards(args: {
  verdict: ClaimVerdict;
  confidence: number;
  nSources: number;
}): { verdict: ClaimVerdict; confidence: number; note?: string } {
  let { verdict, confidence } = args;
  confidence = clamp01(confidence);
  let note: string | undefined;

  if (verdict === "not_checkable") return { verdict, confidence: 0 };

  // Sin fuentes reales no hay veredicto, diga lo que diga el LLM.
  if (args.nSources === 0) {
    if (verdict !== "insufficient_evidence") note = "El buscador no devolvió fuentes reales; veredicto del modelo descartado.";
    return { verdict: "insufficient_evidence", confidence: Math.min(confidence, 0.3), note };
  }
  // Una sola fuente nunca justifica confianza alta.
  if (args.nSources === 1) confidence = Math.min(confidence, 0.7);

  // Mismo umbral en ambas direcciones: ni respaldar ni contradecir con confianza baja.
  if ((verdict === "supported" || verdict === "contradicted") && confidence < 0.5) {
    return { verdict: "insufficient_evidence", confidence, note: "Confianza insuficiente para respaldar o contradecir." };
  }
  return { verdict, confidence, note };
}

// ── 5. dictamen por plantilla ────────────────────────────────────────────────
const T: Record<string, Record<string, string>> = {
  castellano: {
    title: "Informe de contraste afirmación por afirmación",
    head: "Se extrajeron {extracted} afirmaciones del texto; se revisaron {considered}. {searched} eran comprobables como hechos y {nc} no (opiniones o predicciones).",
    result: "Resultado: {s} respaldadas, {p} parcialmente respaldadas, {c} contradichas, {i} sin evidencia suficiente.",
    contradicted: "Afirmaciones contradichas por las fuentes:",
    partial: "Afirmaciones solo parcialmente respaldadas:",
    none: "Ninguna afirmación revisada fue contradicha por las fuentes encontradas.",
    summaryOnly: "AVISO: no había texto original guardado; se auditó el resumen generado, no el artículo.",
    truncated: "AVISO: el texto era muy largo y solo se auditó su primera parte.",
    limits: "Límites: se revisan como máximo {max} afirmaciones por informe y la evidencia procede de una búsqueda automática. Que no se señale un error no garantiza que no exista; conviene revisar las fuentes enlazadas.",
    noClaims: "No se encontraron afirmaciones comprobables en el texto.",
    failExplain: "Falló la búsqueda de evidencia ({err}). Esto no significa que no exista evidencia: vuelve a intentarlo más tarde.",
    failNote: "AVISO: la búsqueda de evidencia falló por un error técnico en {f} de {n} afirmaciones comprobables; ese resultado NO indica ausencia de evidencia. Vuelve a intentarlo más tarde.",
    failedCount: "{f} sin comprobar por fallo de búsqueda.",
    claimsReused: "Se han reutilizado las mismas afirmaciones de la auditoría anterior para que los resultados sean comparables; solo se ha repetido la comprobación de la evidencia.",
    quotaDay: "CUOTA DIARIA DE GEMINI AGOTADA: Google limita las peticiones por proyecto y por día, y se reinicia a medianoche (hora del Pacífico). No se han gastado más peticiones en este informe. Vuelve a auditar después o consulta el panel de límites de AI Studio.",
  },
  galego: {
    title: "Informe de contraste afirmación por afirmación",
    head: "Extraéronse {extracted} afirmacións do texto; revisáronse {considered}. {searched} eran comprobables como feitos e {nc} non (opinións ou predicións).",
    result: "Resultado: {s} avaladas, {p} parcialmente avaladas, {c} contraditas, {i} sen evidencia suficiente.",
    contradicted: "Afirmacións contraditas polas fontes:",
    partial: "Afirmacións só parcialmente avaladas:",
    none: "Ningunha afirmación revisada foi contradita polas fontes atopadas.",
    summaryOnly: "AVISO: non había texto orixinal gardado; auditouse o resumo xerado, non o artigo.",
    truncated: "AVISO: o texto era moi longo e só se auditou a súa primeira parte.",
    limits: "Límites: revísanse como máximo {max} afirmacións por informe e a evidencia procede dunha busca automática. Que non se sinale un erro non garante que non exista; convén revisar as fontes ligadas.",
    noClaims: "Non se atoparon afirmacións comprobables no texto.",
    failExplain: "Fallou a busca de evidencia ({err}). Isto non significa que non exista evidencia: volve tentalo máis tarde.",
    failNote: "AVISO: a busca de evidencia fallou por un erro técnico en {f} de {n} afirmacións comprobables; ese resultado NON indica ausencia de evidencia. Volve tentalo máis tarde.",
    failedCount: "{f} sen comprobar por fallo de busca.",
    claimsReused: "Reutilizáronse as mesmas afirmacións da auditoría anterior para que os resultados sexan comparables; só se repetiu a comprobación da evidencia.",
    quotaDay: "CUOTA DIARIA DE GEMINI ESGOTADA: Google limita as peticións por proxecto e por día, e reiníciase á medianoite (hora do Pacífico). Non se gastaron máis peticións neste informe. Volve auditar despois ou consulta o panel de límites de AI Studio.",
  },
  català: {
    title: "Informe de contrast afirmació per afirmació",
    head: "S'han extret {extracted} afirmacions del text; se n'han revisat {considered}. {searched} eren comprovables com a fets i {nc} no (opinions o prediccions).",
    result: "Resultat: {s} avalades, {p} parcialment avalades, {c} contradites, {i} sense evidència suficient.",
    contradicted: "Afirmacions contradites per les fonts:",
    partial: "Afirmacions només parcialment avalades:",
    none: "Cap afirmació revisada ha estat contradita per les fonts trobades.",
    summaryOnly: "AVÍS: no hi havia text original desat; s'ha auditat el resum generat, no l'article.",
    truncated: "AVÍS: el text era molt llarg i només se n'ha auditat la primera part.",
    limits: "Límits: es revisen com a màxim {max} afirmacions per informe i l'evidència prové d'una cerca automàtica. Que no s'assenyali un error no garanteix que no existeixi; convé revisar les fonts enllaçades.",
    noClaims: "No s'han trobat afirmacions comprovables al text.",
    failExplain: "Ha fallat la cerca d'evidència ({err}). Això no vol dir que no n'hi hagi: torna-ho a provar més tard.",
    failNote: "AVÍS: la cerca d'evidència ha fallat per un error tècnic en {f} de {n} afirmacions comprovables; aquest resultat NO indica absència d'evidència. Torna-ho a provar més tard.",
    failedCount: "{f} sense comprovar per error de cerca.",
    claimsReused: "S'han reutilitzat les mateixes afirmacions de l'auditoria anterior perquè els resultats siguin comparables; només s'ha repetit la comprovació de l'evidència.",
    quotaDay: "QUOTA DIÀRIA DE GEMINI ESGOTADA: Google limita les peticions per projecte i per dia, i es reinicia a mitjanit (hora del Pacífic). No s'han gastat més peticions en aquest informe. Torna a auditar després o consulta el panell de límits d'AI Studio.",
  },
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

export function buildSummary(args: {
  lang: string;
  counts: Record<ClaimVerdict, number>;
  coverage: AuditOutcome["coverage"];
  auditedFrom: AuditOutcome["auditedFrom"];
  checks: ClaimCheck[];
}): string {
  const t = T[args.lang] || T.castellano;
  const { counts: n, coverage: cv } = args;
  if (cv.extracted === 0) return `${t.noClaims}\n\n${t.limits.replace("{max}", String(cv.maxClaims))}`;

  const failed = cv.searchFailed;
  const insufficient = Math.max(0, n.insufficient_evidence - failed); // sin evidencia de verdad, sin contar fallos técnicos
  const evaluated = cv.searched - failed; // afirmaciones con evidencia efectivamente evaluada

  const parts: string[] = [];
  if (args.auditedFrom === "summary_only") parts.push(t.summaryOnly);
  if (cv.textTruncated) parts.push(t.truncated);
  parts.push(fill(t.head, { extracted: cv.extracted, considered: cv.considered, searched: cv.searched, nc: cv.notCheckable }));
  let result = fill(t.result, { s: n.supported, p: n.partially_supported, c: n.contradicted, i: insufficient });
  if (failed > 0) result += " " + fill(t.failedCount, { f: failed });
  parts.push(result);
  if (failed > 0) parts.push(fill(t.failNote, { f: failed, n: cv.searched }));
  if (cv.quota === "day") parts.push(t.quotaDay);
  if (cv.claimsReused) parts.push(t.claimsReused);

  const contra = args.checks.filter((c) => c.verdict === "contradicted");
  const partial = args.checks.filter((c) => c.verdict === "partially_supported");
  if (contra.length) {
    parts.push(`${t.contradicted}\n` + contra.map((c, i) => `${i + 1}. «${c.claim}» → ${c.correction || c.explanation}`).join("\n"));
  } else if (evaluated > 0) {
    // Solo se afirma "ninguna contradicha" si al menos una afirmación llegó a evaluarse con evidencia.
    parts.push(t.none);
  }
  if (partial.length) {
    parts.push(`${t.partial}\n` + partial.map((c, i) => `${i + 1}. «${c.claim}» → ${c.correction || c.explanation}`).join("\n"));
  }
  parts.push(fill(t.limits, { max: cv.maxClaims }));
  return parts.join("\n\n");
}

// ── orquestación ─────────────────────────────────────────────────────────────
export async function runClaimAudit(deps: AuditDeps, input: AuditInput, opts: {
    retryDelayMs?: number;
    concurrency?: number;
    /** Afirmaciones de una auditoría anterior sobre el MISMO texto: se reutilizan en lugar de volver a extraerlas. */
    frozenClaims?: Array<{ claim: string; quote: string; claimType: ClaimType; neutralQuestion: string; importance: number }>;
    frozenExtracted?: number;
  } = {}): Promise<AuditOutcome> {
  const hasOriginal = !!input.sourceText && input.sourceText.trim().length >= MIN_SOURCE_TEXT;
  const auditedFrom: AuditOutcome["auditedFrom"] = hasOriginal ? "original_text" : "summary_only";
  const fullText = hasOriginal
    ? input.sourceText!.trim()
    : `${input.title}\n\n${input.summary}\n\n${input.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  const textTruncated = fullText.length > AUDIT_TEXT_CAP;
  const text = fullText.slice(0, AUDIT_TEXT_CAP);

  // 1) extraer
  const raw: RawClaim[] = opts.frozenClaims && opts.frozenClaims.length ? opts.frozenClaims : await extractClaims(deps, text, input.lang);
  const extracted = opts.frozenClaims && opts.frozenClaims.length ? Math.max(opts.frozenExtracted ?? 0, raw.length) : raw.length;
  // priorizar por importancia y limitar coste; los hechos comprobables primero
  const considered = [...raw]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, AUDIT_MAX_CLAIMS)
    .map((c, i) => ({ ...c, id: `c${i + 1}` }));

  const checkable = considered.filter((c) => c.claimType !== "opinion" && c.claimType !== "prediction");

  // 2) evidencia, con concurrencia acotada y un disyuntor: si la cuota DIARIA está agotada, no se gastan más peticiones
  const evidenceById = new Map<string, Evidence>();
  let dayQuotaHit: Evidence | null = null;
  const search = async (c: { neutralQuestion: string; claim: string }): Promise<Evidence> => {
    if (dayQuotaHit) return { ...dayQuotaHit };
    const ev = await searchEvidence(deps, c.neutralQuestion || c.claim);
    if (ev.failed && ev.quota === "day") dayQuotaHit = ev;
    return ev;
  };
  await mapPool(checkable, opts.concurrency ?? AUDIT_CONCURRENCY, async (c) => {
    evidenceById.set(c.id, await search(c));
  });
  // Segunda pasada, en serie y tras una pausa (la que indique Google, hasta 45 s), solo si el fallo no es de cuota diaria.
  const failedFirst = checkable.filter((c) => evidenceById.get(c.id)?.failed);
  if (failedFirst.length && !dayQuotaHit) {
    const hinted = Math.max(0, ...failedFirst.map((c) => evidenceById.get(c.id)?.retryAfterSec || 0));
    const wait = opts.retryDelayMs === 0 ? 0 : Math.max(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, Math.min(45, hinted) * 1000);
    await new Promise((r) => setTimeout(r, wait));
    for (const c of failedFirst) evidenceById.set(c.id, await search(c));
  }

  // 3) juicio (una sola llamada) solo para las afirmaciones cuya búsqueda funcionó
  const judgeable = checkable.filter((c) => !evidenceById.get(c.id)?.failed);
  const judged = new Map<string, any>();
  if (judgeable.length) {
    try {
      const results = await judgeClaims(
        deps,
        judgeable.map((c) => ({
          id: c.id,
          claim: c.claim,
          evidence: evidenceById.get(c.id)?.text || "",
          nSources: evidenceById.get(c.id)?.sources.length || 0,
        })),
        input.lang
      );
      for (const r of results) if (r && typeof r.id === "string") judged.set(r.id, r);
    } catch {
      /* si el juicio falla, esas afirmaciones quedan como evidencia insuficiente (ver abajo) */
    }
  }

  // 4) montar resultados aplicando reglas deterministas
  const claimChecks: ClaimCheck[] = considered.map((c) => {
    const located = !!c.quote && locateFragment(c.quote, fullText);
    const base = {
      id: c.id,
      claim: c.claim,
      quote: located ? c.quote : "",
      quoteLocated: located,
      claimType: c.claimType,
      neutralQuestion: c.neutralQuestion,
      importance: c.importance,
    };
    if (c.claimType === "opinion" || c.claimType === "prediction") {
      return {
        ...base,
        verdict: "not_checkable" as ClaimVerdict,
        confidence: 0,
        explanation: c.claimType === "opinion" ? "Juicio de valor: no es comprobable como hecho." : "Predicción: no es comprobable como hecho presente.",
        evidence: [],
      };
    }
    const ev: Evidence = evidenceById.get(c.id) || { text: "", sources: [], failed: false };
    if (ev.failed) {
      const tt = T[input.lang] || T.castellano;
      return {
        ...base,
        verdict: "insufficient_evidence" as ClaimVerdict,
        confidence: 0,
        explanation: fill(tt.failExplain, { err: ev.error || "error desconocido" }),
        evidence: [],
        searchFailed: true,
      };
    }
    const j = judged.get(c.id);
    const rawVerdict: ClaimVerdict = j && VERDICTS.includes(j.verdict) && j.verdict !== "not_checkable" ? j.verdict : "insufficient_evidence";
    const g = applyGuards({ verdict: rawVerdict, confidence: j ? j.confidence : 0, nSources: ev.sources.length });

    const evidenceQuote = j && typeof j.evidenceQuote === "string" && words(j.evidenceQuote).length <= 25 && locateFragment(j.evidenceQuote, ev.text) ? j.evidenceQuote.trim() : undefined;
    const correction = g.verdict === "contradicted" || g.verdict === "partially_supported" ? clip(j?.correction, 500) || undefined : undefined;
    const explanation = [g.note, clip(j?.explanation, 600)].filter(Boolean).join(" ") || "Sin evidencia suficiente para pronunciarse.";
    // dedup por URL, máx. 4
    const seen = new Set<string>();
    const evidence = ev.sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true))).slice(0, 4);

    return { ...base, verdict: g.verdict, confidence: g.confidence, explanation, correction, evidenceQuote, evidence };
  });

  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<ClaimVerdict, number>;
  for (const c of claimChecks) counts[c.verdict]++;

  const coverage = {
    extracted,
    considered: considered.length,
    searched: checkable.length,
    notCheckable: considered.length - checkable.length,
    textTruncated,
    maxClaims: AUDIT_MAX_CLAIMS,
    searchFailed: claimChecks.filter((c) => c.searchFailed).length,
    quota: dayQuotaHit ? ("day" as const) : undefined,
    claimsReused: opts.frozenClaims && opts.frozenClaims.length ? true : undefined,
  };

  const hasProblem = claimChecks.some((c) => (c.verdict === "contradicted" || c.verdict === "partially_supported") && c.confidence >= 0.5);
  const status: AuditOutcome["status"] = hasProblem ? "corrected" : counts.supported >= 1 && counts.insufficient_evidence === 0 ? "verified" : "inconclusive";

  const dedup = new Map<string, { title: string; url: string }>();
  for (const c of claimChecks) for (const s of c.evidence) if (!dedup.has(s.url)) dedup.set(s.url, s);

  const strongCorrections = claimChecks
    .filter((c) => c.verdict === "contradicted" && c.confidence >= 0.7 && c.evidence.length >= 1 && c.correction)
    .map((c) => `${c.claim} → ${c.correction}`);

  const t = T[input.lang] || T.castellano;
  return {
    claimChecks,
    counts,
    coverage,
    auditedFrom,
    status,
    summaryAudit: buildSummary({ lang: input.lang, counts, coverage, auditedFrom, checks: claimChecks }),
    verdictTitle: t.title,
    verifiedSources: [...dedup.values()],
    strongCorrections,
  };
}

// ── aplicar solo las correcciones fuertes (opcional) ─────────────────────────
const rewriteSchema = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: { type: Type.STRING },
    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["executiveSummary", "keyPoints"],
};

export async function rewriteWithCorrections(
  deps: AuditDeps,
  args: { summary: string; keyPoints: string[]; corrections: string[]; lang: string }
): Promise<{ executiveSummary: string; keyPoints: string[] } | null> {
  const system = `Aplicas correcciones puntuales a un texto. Cambia ÚNICAMENTE las frases afectadas por las correcciones listadas.
No añadas información nueva, no elimines contenido, no reformules lo demás. Mantén el idioma (${args.lang}), el tono y la estructura.`;
  const prompt = `CORRECCIONES A APLICAR (formato "afirmación errónea → dato correcto"):\n${args.corrections.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nRESUMEN ACTUAL:\n${args.summary}\n\nPUNTOS CLAVE ACTUALES:\n${args.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nDevuelve el resumen y los puntos clave con solo esos cambios.`;
  try {
    const out = parseJson(await deps.llmJson(prompt, system, rewriteSchema));
    const s = typeof out?.executiveSummary === "string" ? out.executiveSummary.trim() : "";
    const k: string[] = Array.isArray(out?.keyPoints) ? out.keyPoints.filter((x: any) => typeof x === "string" && x.trim()) : [];
    if (!s || !k.length) return null;
    // Freno anti-deriva: un cambio puntual no debe alterar mucho la longitud ni el número de puntos.
    const ratio = s.length / Math.max(1, args.summary.length);
    if (ratio < 0.7 || ratio > 1.3) return null;
    if (k.length !== args.keyPoints.length) return null;
    return { executiveSummary: s, keyPoints: k };
  } catch {
    return null;
  }
}
