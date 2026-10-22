// Estabilidad entre ejecuciones.
//
// Un LLM es probabilístico y Google solo garantiza "mejor esfuerzo" con la semilla (y recomienda no bajar la temperatura
// en Gemini 3). Por eso la estabilidad NO se apoya en parámetros, sino en CONGELAR la capa auditada:
//   · Se calcula un hash del contenido analizado y una versión del pipeline (prompts, reglas, notas de contexto).
//   · Si el mismo contenido ya fue analizado con la misma versión, se reutiliza el análisis: fuentes, críticas y papers
//     no cambian. Para obtener uno nuevo hay que pedirlo explícitamente ("Reanalizar desde cero").
//   · La capa auditada va firmada con HMAC: un cliente no puede inyectar fuentes que el servidor no produjo.
//   · Además se fija una semilla derivada del hash (mismo texto → misma semilla) para reducir la variación cuando sí
//     hay que volver a generar.
import crypto from "node:crypto";
import { normalizeText } from "./citations";

/** Súbela cuando cambien prompts, esquemas o reglas de verificación: los análisis antiguos dejarán de reutilizarse. */
export const PIPELINE_BASE_VERSION = "2026-10-21.1";

export const MIN_FREEZE_CHARS = 500; // por debajo de esto no hay contenido real que congelar

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeText(text).slice(0, 200_000)).digest("hex");
}

/** Semilla de 28 bits derivada del hash: estable para un mismo contenido. */
export const seedFromHash = (hash: string): number => parseInt(hash.slice(0, 7), 16);

export function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

export interface FrozenInfo {
  contentHash: string;
  pipelineVersion: string;
  frozenAt: string;
  sig: string;
}

/** La capa que debe permanecer estable: fuentes, críticas, lectura de explorador y notas de contexto. */
export function auditedLayer(a: any) {
  return {
    criticalPositions: a?.criticalPositions ?? [],
    bibliographicSources: a?.bibliographicSources ?? [],
    scoutAssessment: a?.scoutAssessment ?? null,
    contextNotes: a?.contextNotes ?? [],
  };
}

const hmac = (secret: string, hash: string, version: string, layer: any) =>
  crypto.createHmac("sha256", secret).update(`${hash}|${version}|${stableStringify(layer)}`).digest("hex");

export function signAnalysis(secret: string, analysis: any, hash: string, version: string): FrozenInfo {
  return { contentHash: hash, pipelineVersion: version, frozenAt: new Date().toISOString(), sig: hmac(secret, hash, version, auditedLayer(analysis)) };
}

export function verifyFrozen(secret: string, analysis: any, hash: string, version: string): boolean {
  const f: FrozenInfo | undefined = analysis?.frozen;
  if (!f || f.contentHash !== hash || f.pipelineVersion !== version || typeof f.sig !== "string") return false;
  const expected = Buffer.from(hmac(secret, hash, version, auditedLayer(analysis)), "hex");
  const given = Buffer.from(f.sig, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Primer candidato con firma válida para ESTE contenido y ESTA versión del pipeline. */
export function findReusable(candidates: any[], secret: string, hash: string, version: string): any | null {
  for (const c of candidates) if (c && verifyFrozen(secret, c, hash, version)) return c;
  return null;
}
