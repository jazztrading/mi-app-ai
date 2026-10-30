// Podcasts, vídeos y fotos · de "lo que dice la página" a "lo que dice el contenido".
// Hasta ahora, una URL de podcast se analizaba por sus notas web (unas pocas líneas) y un vídeo de YouTube
// sin subtítulos se trataba como "tutorial mudo". Este módulo obtiene el contenido real:
//   · audio  → se localiza el archivo en la página, se descarga (anti-SSRF) y se transcribe con Gemini
//   · YouTube → subtítulos si existen; si no, Gemini procesa el vídeo público directamente
//   · fotos  → paso OCR dedicado (texto literal) antes del análisis, para que se pueda revisar y auditar
// Toda transcripción lleva TranscriptInfo: quién la generó, si está completa y de qué fuente viene.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { FileState, createPartFromUri, type GoogleGenAI } from "@google/genai";
import { safeDownload } from "./safeFetch";

export type TranscriptSource = "audio" | "youtube-captions" | "youtube-video" | "ocr" | "show-notes" | "none";

export interface TranscriptInfo {
  source: TranscriptSource;
  /** ia = generada por un modelo; subtitulos = subtítulos de YouTube; pagina = solo texto de la página. */
  generatedBy: "ia" | "subtitulos" | "pagina";
  /** true solo si el modelo confirmó el final del audio/vídeo. */
  complete: boolean;
  model?: string;
  passes?: number;
  audioUrl?: string;
  note?: string;
}

export interface MediaDeps {
  ai: GoogleGenAI;
  models: string[];
}

export interface TranscriptResult {
  text: string;
  complete: boolean;
  passes: number;
  model: string;
  note?: string;
}

export const END_MARKER = "[FIN DE LA TRANSCRIPCIÓN]";
const MAX_PASSES = 6;
export const MIN_AUDIO_BYTES = 200 * 1024; // por debajo es un efecto de sonido de la plantilla, no un episodio
export const MAX_AUDIO_BYTES = (Number(process.env.MAX_AUDIO_MB) || 120) * 1024 * 1024;

// ───────────────────────── Localizar el audio en una página ─────────────────────────

const AUDIO_EXT_RE = /\.(?:mp3|m4a|aac|oga|ogg|opus|wav|flac)$/i;
const RAW_AUDIO_URL_RE = /https?:\/\/[^\s"'<>()\\]+?\.(?:mp3|m4a|aac|oga|ogg|opus|wav|flac)(?:\?[^\s"'<>()\\]*)?/gi;
const DOWNLOAD_PATH_RE = /\/(?:podcast-download|download)\//i;

/** true si la ruta de la URL termina en una extensión de audio (ignora query y hash). */
export function isDirectAudioUrl(raw: string): boolean {
  try {
    return AUDIO_EXT_RE.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

function collectContentUrls(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) collectContentUrls(n, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "contentUrl" && typeof v === "string") out.push(v);
      else collectContentUrls(v, out, depth + 1);
    }
  }
}

/**
 * Devuelve las URLs candidatas a ser el audio del episodio, ordenadas por fiabilidad:
 * archivos de audio directos primero, enlaces de descarga con redirección después.
 * Fuentes: og:audio, <audio>/<source>, JSON-LD (contentUrl), enlaces y, como último recurso, un barrido del HTML.
 */
export function findAudioCandidates(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw.trim().replace(/&amp;/g, "&"), pageUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    ordered.push(abs);
  };

  $(
    'meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"], meta[name="twitter:player:stream"]'
  ).each((_, el) => add($(el).attr("content")));

  $("audio[src], audio source[src]").each((_, el) => add($(el).attr("src")));

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const urls: string[] = [];
      collectContentUrls(JSON.parse($(el).html() || ""), urls);
      urls.forEach(add);
    } catch {
      /* JSON-LD mal formado: se ignora */
    }
  });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let pathname = "";
    try {
      pathname = new URL(href, pageUrl).pathname;
    } catch {
      return;
    }
    if (AUDIO_EXT_RE.test(pathname) || DOWNLOAD_PATH_RE.test(pathname)) add(href);
  });

  for (const m of html.matchAll(RAW_AUDIO_URL_RE)) add(m[0]);

  return [...ordered.filter(isDirectAudioUrl), ...ordered.filter((u) => !isDirectAudioUrl(u))];
}

/** Tipos MIME a probar para un archivo, del más probable al menos. Gemini documenta mp3/aac/ogg/wav/flac/aiff; m4a no figura en todas las tablas, de ahí la lista de alternativas. */
export function mimeCandidatesFor(urlOrName: string, contentType = ""): string[] {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  let ext = "";
  try {
    ext = path.extname(new URL(urlOrName).pathname).toLowerCase();
  } catch {
    ext = path.extname(urlOrName).toLowerCase();
  }
  const byExt: Record<string, string[]> = {
    ".mp3": ["audio/mp3", "audio/mpeg"],
    ".m4a": ["audio/m4a", "audio/mp4", "audio/aac"],
    ".aac": ["audio/aac"],
    ".ogg": ["audio/ogg"],
    ".oga": ["audio/ogg"],
    ".opus": ["audio/opus", "audio/ogg"],
    ".wav": ["audio/wav"],
    ".flac": ["audio/flac"],
  };
  const list = [...(byExt[ext] || [])];
  if (ct.startsWith("audio/") && !list.includes(ct)) list.push(ct);
  if (list.length === 0) list.push("audio/mpeg", "audio/mp3", "audio/mp4");
  return list;
}

// ───────────────────────── Descarga ─────────────────────────

export interface DownloadedAudio {
  filePath: string;
  dir: string;
  bytes: number;
  url: string;
  mimeCandidates: string[];
  cleanup: () => void;
}

/** Prueba hasta `maxTries` candidatos y se queda con el primero que sea un audio de tamaño razonable. */
export async function downloadFirstAudio(
  candidates: string[],
  opts: { maxBytes?: number; maxTries?: number } = {}
): Promise<{ audio: DownloadedAudio | null; errors: string[] }> {
  const { maxBytes = MAX_AUDIO_BYTES, maxTries = 3 } = opts;
  const errors: string[] = [];
  for (const url of candidates.slice(0, maxTries)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lupa-audio-"));
    const filePath = path.join(dir, `audio-${crypto.randomBytes(4).toString("hex")}`);
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
      const r = await safeDownload(url, filePath, {
        maxBytes,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LupaCritica/1.0)", Accept: "audio/*,*/*;q=0.8" },
      });
      const ct = r.contentType.toLowerCase();
      if (ct.startsWith("text/") || ct.includes("json") || ct.includes("html")) {
        throw new Error("El enlace devuelve una página, no un audio.");
      }
      if (r.bytes < MIN_AUDIO_BYTES) throw new Error("El archivo es demasiado pequeño para ser un episodio.");
      return {
        audio: { filePath, dir, bytes: r.bytes, url: r.finalUrl, mimeCandidates: mimeCandidatesFor(r.finalUrl, r.contentType), cleanup },
        errors,
      };
    } catch (e: any) {
      cleanup();
      errors.push(`${url}: ${e?.message || e}`);
    }
  }
  return { audio: null, errors };
}

// ───────────────────────── Llamadas a Gemini ─────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|high demand|rate-limits|quota|timeout|ECONNRESET|fetch failed/i.test(m);
const isBadMime = (m: string) => /INVALID_ARGUMENT|mime|unsupported|not supported|format/i.test(m) && !isTransient(m);

async function generateWithFallback(
  deps: MediaDeps,
  contents: any,
  config: Record<string, any>,
  label: string
): Promise<{ text: string; finishReason: string; model: string }> {
  let lastErr: any = null;
  for (const model of deps.models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await deps.ai.models.generateContent({ model, contents, config });
        const text = (response.text || "").trim();
        const finishReason = String(response.candidates?.[0]?.finishReason || "");
        if (text || finishReason === "STOP") return { text, finishReason, model };
        lastErr = new Error(`${label}: respuesta vacía (${finishReason || "sin motivo"})`);
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        console.warn(`[Media ${label}] ${model} intento ${attempt}: ${msg.slice(0, 300)}`);
        if (isBadMime(msg)) throw e; // no se arregla cambiando de modelo
        if (isTransient(msg) && attempt === 1) {
          await sleep(2500 + Math.random() * 1500);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error(`${label}: no se obtuvo respuesta de ningún modelo.`);
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Bucle común de transcripción: pide el texto y, si el modelo se corta o no confirma el final, continúa donde lo dejó. */
async function transcribeLoop(
  deps: MediaDeps,
  mediaPart: any,
  firstPrompt: string,
  label: string
): Promise<TranscriptResult> {
  let acc = "";
  let complete = false;
  let passes = 0;
  let model = deps.models[0];
  let note: string | undefined;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    passes = pass;
    const prompt =
      pass === 1
        ? firstPrompt
        : `Continúa la transcripción exactamente donde terminó. Lo último transcrito fue:\n"""\n${acc.slice(-500)}\n"""\n` +
          `Sigue con la frase siguiente del audio, sin repetir nada de lo anterior, con el mismo formato y marcas de tiempo. ` +
          `Si ya no queda nada por transcribir, responde únicamente: ${END_MARKER}`;

    const r = await generateWithFallback(
      deps,
      [{ role: "user", parts: [mediaPart, { text: prompt }] }],
      { temperature: 0 },
      `${label} pasada ${pass}`
    );
    model = r.model;
    let chunk = r.text;
    const hasEnd = chunk.includes(END_MARKER);
    chunk = chunk.replace(END_MARKER, "").trim();

    // Anti-bucle: si el modelo repite lo que ya había, se corta aquí.
    if (pass > 1 && chunk.length > 80 && norm(acc).includes(norm(chunk).slice(0, 160))) {
      note = "El modelo empezó a repetirse; la transcripción se ha cortado en ese punto.";
      break;
    }
    if (chunk) acc += (acc ? "\n\n" : "") + chunk;
    if (hasEnd) {
      complete = true;
      break;
    }
    if (!chunk) break; // sin más texto y sin marca de fin: no se puede confirmar
  }

  if (!complete && !note) note = "El modelo no confirmó el final del contenido; puede faltar la parte final.";
  return { text: acc.trim(), complete, passes, model, note };
}

async function waitUntilActive(ai: GoogleGenAI, name: string, timeoutMs = 180_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const f: any = await ai.files.get({ name });
    if (f.state === FileState.ACTIVE) return f;
    if (f.state === FileState.FAILED) throw new Error("Gemini no pudo procesar el archivo de audio.");
    if (Date.now() - t0 > timeoutMs) throw new Error("Tiempo agotado esperando a que Gemini procese el audio.");
    await sleep(2500);
  }
}

function audioPrompt(ctx: { title?: string }): string {
  return `Transcribe este audio de forma íntegra y literal, de principio a fin.
Reglas:
- Conserva el idioma original: no traduzcas, no resumas, no parafrasees, no corrijas el contenido y no añadas comentarios tuyos.
- Cada intervención o párrafo empieza con una marca de tiempo [MM:SS] (o [H:MM:SS] pasada la primera hora). Si hay más de una voz, añade una etiqueta "Voz 1:", "Voz 2:"… Usa un nombre propio solo si se dice expresamente en el audio.
- Escribe con puntuación y párrafos normales. Respeta cifras, nombres propios y citas tal y como se dicen.
- Si algo no se entiende, escribe [inaudible]. Si dudas de una palabra, escríbela seguida de [?].
- Música, sintonías y publicidad: indícalo en una línea entre corchetes ([música], [publicidad]) sin transcribir letras cantadas.
- No inventes nada que no se oiga. Si el audio termina, termina la transcripción.
- Cuando acabes el audio, escribe en una última línea exactamente: ${END_MARKER}
${ctx.title ? `\nTítulo del episodio (solo como ayuda ortográfica para nombres propios; no es contenido): "${ctx.title}"\n` : ""}
Devuelve únicamente la transcripción.`;
}

/** Sube un archivo de audio local a la Files API de Gemini y lo transcribe. Prueba varios MIME si el primero se rechaza. */
export async function transcribeAudioFile(
  deps: MediaDeps,
  filePath: string,
  mimeCandidates: string[],
  ctx: { title?: string } = {}
): Promise<TranscriptResult> {
  let lastErr: any = null;
  for (const mimeType of mimeCandidates) {
    let uploadedName: string | undefined;
    try {
      const up: any = await deps.ai.files.upload({ file: filePath, config: { mimeType } });
      uploadedName = up.name;
      const active = await waitUntilActive(deps.ai, up.name);
      const part = createPartFromUri(active.uri, active.mimeType || mimeType);
      return await transcribeLoop(deps, part, audioPrompt(ctx), "audio");
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      console.warn(`[Media audio] MIME ${mimeType} falló: ${msg.slice(0, 300)}`);
      if (!isBadMime(msg)) throw e;
    } finally {
      if (uploadedName) deps.ai.files.delete({ name: uploadedName }).catch(() => undefined); // caduca solo a las 48 h; se borra antes por limpieza
    }
  }
  throw lastErr || new Error("Gemini no aceptó ningún formato para este audio.");
}

/** Transcribe un vídeo público de YouTube pasándoselo a Gemini por URL (no se descarga nada). */
export async function transcribeYouTubeVideo(deps: MediaDeps, url: string, ctx: { title?: string } = {}): Promise<TranscriptResult> {
  const prompt = `Transcribe lo que se dice en este vídeo, de principio a fin y de forma literal.
Reglas:
- Conserva el idioma original: no traduzcas ni resumas ni añadas comentarios tuyos.
- Cada intervención o párrafo empieza con una marca de tiempo [MM:SS] (o [H:MM:SS]). Si hay varias voces, etiqueta "Voz 1:", "Voz 2:"… y usa un nombre solo si se dice o aparece escrito en pantalla.
- Si en un tramo no hay voz (música, demostración, tutorial mudo), descríbelo en una línea entre corchetes con las acciones o instrucciones visibles y el texto en pantalla relevante, p. ej. [en pantalla: …]. No inventes lo que no se vea ni se oiga.
- Si algo no se entiende, escribe [inaudible]. Si dudas de una palabra, escríbela seguida de [?].
- Cuando acabes el vídeo, escribe en una última línea exactamente: ${END_MARKER}
${ctx.title ? `\nTítulo (solo ayuda ortográfica): "${ctx.title}"\n` : ""}
Devuelve únicamente la transcripción.`;
  return transcribeLoop(deps, { fileData: { fileUri: url } }, prompt, "youtube");
}

export interface PodcastResult {
  ok: boolean;
  text?: string;
  info?: TranscriptInfo;
  error?: string;
}

/** Orquesta: descarga el primer audio válido, lo transcribe y limpia el temporal. Nunca lanza: devuelve ok:false con el motivo. */
export async function transcribePodcast(deps: MediaDeps, candidates: string[], ctx: { title?: string } = {}): Promise<PodcastResult> {
  if (candidates.length === 0) return { ok: false, error: "No se encontró ningún archivo de audio en la página." };
  const { audio, errors } = await downloadFirstAudio(candidates);
  if (!audio) return { ok: false, error: `No se pudo descargar el audio. ${errors.slice(0, 2).join(" | ")}`.slice(0, 600) };
  try {
    const r = await transcribeAudioFile(deps, audio.filePath, audio.mimeCandidates, ctx);
    if (r.text.length < 100) return { ok: false, error: "La transcripción devuelta está vacía o es demasiado corta." };
    return {
      ok: true,
      text: r.text,
      info: { source: "audio", generatedBy: "ia", complete: r.complete, model: r.model, passes: r.passes, audioUrl: audio.url, note: r.note },
    };
  } catch (e: any) {
    return { ok: false, error: `Falló la transcripción: ${String(e?.message || e).slice(0, 400)}` };
  } finally {
    audio.cleanup();
  }
}

// ───────────────────────── Fotos (OCR dedicado) ─────────────────────────

export interface ImageInput {
  mimeType: string;
  data: string; // base64 sin cabecera
}

/** Transcribe el texto impreso de una o varias fotos. Texto literal, con marcas de duda; no resume ni traduce. */
export async function transcribeImages(deps: MediaDeps, images: ImageInput[]): Promise<{ text: string; model: string }> {
  if (images.length === 0) return { text: "", model: deps.models[0] };
  const prompt = `Transcribe fielmente el texto impreso visible en ${images.length === 1 ? "esta imagen" : "estas imágenes"} (recortes de prensa, revistas, páginas de libro o documentos).
- Respeta el orden de lectura: titular, antetítulo, subtítulo, firma, cuerpo (columna por columna, de izquierda a derecha), pies de foto, recuadros y datos de infografías.
- Transcribe literalmente, incluidas cifras, nombres propios y comillas. No resumas, no traduzcas, no corrijas y no completes lo que no se vea.
- Si una palabra o cifra no se lee con seguridad, escribe [ilegible], o tu mejor lectura seguida de [?].
- Si hay varias imágenes, sepáralas con una línea "--- Imagen N ---" en el orden recibido.
- Los elementos no textuales relevantes (gráficos, fotos) se indican en una línea breve entre corchetes, p. ej. [gráfico: barras de gasto por año].
Devuelve únicamente la transcripción.`;
  const parts = [...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: prompt }];
  const r = await generateWithFallback(deps, [{ role: "user", parts }], { temperature: 0 }, "ocr");
  return { text: r.text, model: r.model };
}

// ───────────────────────── Aviso al modelo según el origen del texto ─────────────────────────

const NO_COPY_RULE =
  "La transcripción ya se muestra aparte en la app: NO la copies en 'translation' (déjalo vacío si el idioma es castellano, gallego o catalán; si está en otro idioma, 'translation' contendrá su traducción).";

/** Frase que se añade al prompt de análisis para que el modelo sepa de dónde sale el texto y cuánto fiarse de él. */
export function mediaNoteFor(info: TranscriptInfo | undefined): string {
  if (!info) return "";
  const incompleta = info.complete ? "" : " ATENCIÓN: la transcripción está INCOMPLETA; no concluyas nada sobre lo que no consta en ella.";
  switch (info.source) {
    case "audio":
      return `Nota: el texto incluye (1) las notas de la página del episodio y (2) una transcripción automática del audio generada por IA, con marcas de tiempo [MM:SS]. Puede contener errores de reconocimiento (nombres propios, cifras): si una crítica depende de una cifra o un nombre dudoso, dilo. Distingue lo que dice el episodio de lo que dicen las notas de la web. ${NO_COPY_RULE}${incompleta}`;
    case "youtube-video":
      return `Nota: el texto es una transcripción automática del vídeo generada por IA, con marcas de tiempo [MM:SS] y descripciones de lo visible entre corchetes. Puede contener errores de reconocimiento. ${NO_COPY_RULE}${incompleta}`;
    case "youtube-captions":
      return `Nota: el texto son los subtítulos de YouTube (pueden ser automáticos, sin puntuación y con errores en nombres propios y cifras). ${NO_COPY_RULE}${incompleta}`;
    case "ocr":
      return "Nota: el texto procede de una transcripción OCR automática de fotografías y puede contener errores de lectura. No atribuyas al autor erratas evidentes ni cifras dudosas (marcadas con [?] o [ilegible]).";
    case "show-notes":
      return "Nota: solo se dispone de las notas de la página del episodio; NO se ha podido acceder al audio. No atribuyas al episodio contenido que no consta en las notas, limita el análisis a ellas y concluye 'insuficiente' en la suficiencia de la evidencia cuando proceda.";
    default:
      return "";
  }
}
