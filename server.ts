import express from "express";
import path from "path";
import fs from "fs";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import {
  HttpError, MAX_BODY_MB, requireAuth, failedAuthLimiter, apiLimiter, costlyLimiter,
  securityHeaders, ID_RE, validateAnalyzeBody, dailyCostlyCap, dailyCostlyMax, isAuthRequired,
} from "./server/security";
import { safeFetch, parseAndValidateUrl, UnsafeUrlError } from "./server/safeFetch";
import {
  makeRegistry, resolveCitations, verifyCitation, scoreReliability, locateFragment,
  type CitationInput, type CitationOutput, type FetchResult, type PageFetcher, type RegistryRecord, type StudyDesign, type SupportVerdict, type VerificationStatus,
} from "./server/citations";
import { CONTEXT_NOTES, matchContextNotes, renderNotesForPrompt, type ContextNoteView } from "./server/knowledge";
import nodeCrypto from "node:crypto";
import { PIPELINE_BASE_VERSION, MIN_FREEZE_CHARS, contentHash, seedFromHash, signAnalysis, findReusable, type FrozenInfo } from "./server/stability";
import { runClaimAudit, rewriteWithCorrections, parseGeminiError, type AuditDeps, type ClaimCheck, type ClaimVerdict } from "./server/audit";

// Load environment variables
dotenv.config();

const PORT = Number(process.env.PORT) || 3000; // Render inyecta PORT
const DB_FILE = path.join(process.env.DATA_DIR || process.cwd(), "analyses_db.json");

// Initialize Gemini SDK with recommended user-agent header
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("FATAL: falta GEMINI_API_KEY (defínela como variable de entorno del host, nunca en el repo).");
  process.exit(1);
}
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

export interface VerifiedScholarlyCitation {
  title: string;
  author: string;
  year?: string;
  doi?: string;
  journalOrVenue?: string;
  citationsCount?: number;
  openAccessUrl?: string;
  isVerified?: boolean; // OBSOLETO: se conserva para registros antiguos; usar verificationStatus
  verificationStatus?: VerificationStatus; // exact | probable | related_unverified | not_found
  supportVerdict?: SupportVerdict; // ¿el resumen de la obra respalda la afirmación?
  supportQuote?: string; // frase literal del resumen que lo prueba
  isRetracted?: boolean;
  hasConcern?: boolean;
  verificationNotes?: string[];
  link: string;
}

interface CriticalPosition {
  title: string;
  argument: string;
  scientificBasis: string;
  targetClaim?: string; // frase literal del texto analizado a la que apunta la crítica
  targetClaimLocated?: boolean;
  critiqueType?: string;
  evidenceThatWouldSettleIt?: string;
  suggestedSources?: string[]; // instituciones o bases de datos a consultar (sin enlaces inventados)
  contextNoteIds?: string[]; // notas de contexto curadas en las que se apoya (las fuentes las pone la app, no el modelo)
  supportingStudy?: VerifiedScholarlyCitation;
  studyDiscardedNote?: string;
}

export interface ScoutAssessment {
  whereAuthorIsRight: string[];
  strongestVersion: string;
  implicationsIfTrue: string[];
  whatWouldChangeTheConclusion: string[];
  evidenceSufficiency: "suficiente" | "parcial" | "insuficiente";
  sufficiencyNote?: string;
}

interface ConstructiveDebatesSummary {
  overview: string;
  keyQuestions: string[];
  consensusAndDisagreements?: string;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  simpleExample: string;
  scientificEvidenceOrSource?: string;
  evidenceVerification?: VerificationStatus;
  referenceUrl: string;
  referenceKind?: "verified" | "search"; // "verified": obra localizada; "search": solo un enlace de búsqueda, NO una fuente verificada
}

export interface BibliographicSource {
  title: string;
  author: string;
  year?: string;
  type: string;
  link: string;
  summary: string;
  criticalAnalysis: string;
  reliabilityScore?: number | null; // derivada de una rúbrica; null = no evaluable (obra no verificada)
  reliabilityBasis?: string[];
  academicRigor: string;
  doi?: string;
  journalOrVenue?: string;
  isVerified?: boolean; // OBSOLETO
  verificationStatus?: VerificationStatus;
  supportVerdict?: SupportVerdict;
  supportQuote?: string;
  isRetracted?: boolean;
  hasConcern?: boolean;
  verificationNotes?: string[];
  citationsCount?: number;
  openAccessUrl?: string;
  isRecent?: boolean;
  currencyReason?: string;
  currencyTag?: string;
}

interface NumericalExample {
  concept: string;
  figureOrCost: string;
  explanation: string;
}

export interface DataContrastItem {
  claimOrFact: string;
  officialVerification: string;
  status: "verified" | "corrected" | "clarified";
  reliableSource: string;
  sourceUrl?: string;
}

export interface FactCheckAudit {
  auditedAt: string;
  status: "verified" | "corrected" | "inconclusive";
  verdictTitle?: string;
  summaryAudit: string;
  detectedErrors: string[];
  correctionsApplied: string[];
  contrastTable?: DataContrastItem[];
  verifiedSources: Array<{ title: string; url: string; snippet?: string; reliability?: string }>;
  userFeedback?: string;
  // Auditoría v2 (todos opcionales: los registros anteriores no necesitan migración)
  method?: "claim_level_v2";
  auditedFrom?: "original_text" | "summary_only";
  claimChecks?: ClaimCheck[];
  counts?: Record<ClaimVerdict, number>;
  coverage?: { extracted: number; considered: number; searched: number; notCheckable: number; textTruncated: boolean; maxClaims: number; searchFailed?: number; quota?: "day" | "minute"; claimsReused?: boolean };
  textHash?: string; // hash del texto auditado: si no cambia, se reutilizan las mismas afirmaciones
  previousExecutiveSummary?: string;
  previousKeyPoints?: string[];
}

export interface AnalysisResult {
  id: string;
  url: string;
  title: string;
  originalLanguage: string;
  outputLanguage?: string;
  isSpanishOrGalician: boolean;
  categories: string[];
  translation?: string;
  originalExtractedText?: string;
  executiveSummary: string;
  keyPoints: string[];
  numericalExamples?: NumericalExample[];
  academicDebates?: string;
  criticalPositions?: CriticalPosition[];
  constructiveDebatesSummary?: ConstructiveDebatesSummary;
  glossary?: GlossaryTerm[];
  bibliographicSources: BibliographicSource[];
  analyzedAt: string;
  contentType: "blog" | "podcast" | "youtube" | "manual" | "photo" | "document";
  photoUrls?: string[];
  fileNames?: string[];
  overallReliabilityScore?: number | null;
  scoutAssessment?: ScoutAssessment;
  contextNotes?: ContextNoteView[];
  frozen?: FrozenInfo; // firma de la capa auditada: permite reutilizar el análisis sin que fuentes ni críticas cambien
  factCheckAudit?: FactCheckAudit;
  isEditedManually?: boolean;
}

// Detect language of user query or content (Galego, Català, Castellano, English)
export function detectLanguage(text: string): "galego" | "català" | "castellano" | "english" | "other" {
  if (!text) return "castellano";
  const lower = text.toLowerCase();

  // Galician markers (Galego)
  const galegoKeywords = [
    /\bcal\b/, /\bfoi\b/, /\bmellor\b/, /\bquenes\b/, /\bescanos\b/, /\bdeputados\b/,
    /\blexislativas\b/, /\bgalego\b/, /\bgalega\b/, /\bgalicia\b/, /\bgaliza\b/,
    /\beleccións\b/, /\beleiçoes\b/, /\bconcellos\b/, /\bxunta\b/,
    /\btamén\b/, /\bdespois\b/, /\bsempre\b/, /\bninguén\b/, /\boutro\b/, /\boutra\b/,
    /\bengadir\b/, /\bconsultar\b/, /\bpolo\b/, /\bpola\b/, /\bpolos\b/, /\bpolas\b/,
    /\bconseguiu\b/, /\bobtivo\b/, /\bpersoas\b/, /\bacadar\b/, /\bprimeiro\b/, /\bsegundo\b/
  ];
  let galegoScore = 0;
  for (const regex of galegoKeywords) {
    if (regex.test(lower)) galegoScore++;
  }
  if (galegoScore >= 2 || (galegoScore >= 1 && (lower.includes("cal foi") || lower.includes("quenes") || lower.includes("mellor resultado") || lower.includes("bng")))) {
    return "galego";
  }

  // Catalan markers (Català)
  const catalaKeywords = [/\bquin\b/, /\bquina\b/, /\bmillor\b/, /\bva ser\b/, /\bescons\b/, /\bdiputats\b/, /\beleccions\b/, /\btambé\b/];
  if (catalaKeywords.filter(m => m.test(lower)).length >= 2) {
    return "català";
  }

  // English markers
  const englishKeywords = [/\bwhat\b/, /\bwhich\b/, /\bwho\b/, /\bbest\b/, /\bresult\b/, /\belection\b/, /\bseats\b/, /\bthe\b/, /\band\b/, /\bwith\b/];
  if (englishKeywords.filter(m => m.test(lower)).length >= 3) {
    return "english";
  }

  return "castellano";
}

// Helper functions for persistent database
function loadDatabase(): Record<string, AnalysisResult> {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error al cargar la base de datos local:", err);
  }
  return {};
}

function saveDatabase(dbData: Record<string, AnalysisResult>) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), "utf-8");
  } catch (err) {
    console.error("Error al guardar en la base de datos local:", err);
  }
}

// ── Verificación de citas (Fase 1): la lógica vive en server/citations.ts ────────────────────────
// Solo se consultan hosts fijos (Crossref, OpenAlex); no hay URL controlada por el usuario, así que no pasa por safeFetch.
// Secreto para firmar la capa auditada. Define CACHE_SECRET en producción; si no, se deriva de la clave de Gemini (estable, no se expone).
const CACHE_SECRET = process.env.CACHE_SECRET || nodeCrypto.createHash("sha256").update(`lupa-cache:${process.env.GEMINI_API_KEY || ""}`).digest("hex");
// La versión incluye las notas de contexto: si se revisa una nota, los análisis antiguos dejan de reutilizarse.
const pipelineVersion = () => `${PIPELINE_BASE_VERSION}+${nodeCrypto.createHash("sha256").update(CONTEXT_NOTES.map((n) => `${n.id}:${n.reviewedAt}`).join(",")).digest("hex").slice(0, 8)}`;

const registryFetch = async (url: string): Promise<FetchResult> => {
  try {
    const contact = process.env.CONTACT_EMAIL;
    const r = await fetch(url, {
      headers: { "User-Agent": `LupaCritica/1.0${contact ? ` (mailto:${contact})` : ""}` },
      signal: AbortSignal.timeout(6000),
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* sin cuerpo JSON */ }
    return { ok: r.ok, status: r.status, json }; // no se registran URLs: pueden llevar la clave de OpenAlex
  } catch {
    return { ok: false, status: 0, json: null };
  }
};
// Para informes institucionales sin DOI: abre la URL que propone el modelo (con el anti-SSRF de safeFetch) y devuelve el HTML.
const pageFetcher: PageFetcher = async (url) => {
  try {
    const r = await safeFetch(url, {
      timeoutMs: 8000,
      maxBytes: 1_500_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LupaCritica/1.0)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (!r.ok || /pdf|octet-stream/i.test(r.contentType)) return null;
    return { ok: true, html: await r.text(), finalUrl: r.finalUrl };
  } catch {
    return null; // incluye URL no segura o inaccesible
  }
};
const newRegistry = () => makeRegistry({ fetchJson: registryFetch, mailto: process.env.CONTACT_EMAIL, openalexKey: process.env.OPENALEX_API_KEY });

function sanitizeScout(raw: any): ScoutAssessment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const list = (x: any) => (Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.trim()).map((v: string) => v.trim()).slice(0, 5) : []);
  const strongest = typeof raw.strongestVersion === "string" ? raw.strongestVersion.trim() : "";
  const out: ScoutAssessment = {
    whereAuthorIsRight: list(raw.whereAuthorIsRight),
    strongestVersion: strongest,
    implicationsIfTrue: list(raw.implicationsIfTrue),
    whatWouldChangeTheConclusion: list(raw.whatWouldChangeTheConclusion),
    evidenceSufficiency: ["suficiente", "parcial", "insuficiente"].includes(raw.evidenceSufficiency) ? raw.evidenceSufficiency : "parcial",
    sufficiencyNote: typeof raw.sufficiencyNote === "string" ? raw.sufficiencyNote.trim() || undefined : undefined,
  };
  return out.whereAuthorIsRight.length || out.strongestVersion || out.whatWouldChangeTheConclusion.length ? out : undefined;
}

const scholarSearchLink = (title: string, author?: string) =>
  `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${title}" ${author || ""}`.trim())}`;

function toCitationView(rec: RegistryRecord, out: Pick<CitationOutput, "status" | "support" | "supportQuote" | "notes">): VerifiedScholarlyCitation {
  const doiUrl = rec.doi ? `https://doi.org/${rec.doi}` : undefined;
  return {
    title: rec.title,
    author: rec.authors.slice(0, 4).join(", ") + (rec.authors.length > 4 ? " et al." : "") || "Autoría no indicada en el registro",
    year: rec.year ? String(rec.year) : undefined,
    doi: doiUrl,
    journalOrVenue: rec.venue,
    citationsCount: rec.citedBy,
    openAccessUrl: rec.openAccessUrl,
    isVerified: out.status === "exact",
    verificationStatus: out.status,
    supportVerdict: out.support,
    supportQuote: out.supportQuote,
    isRetracted: rec.isRetracted || undefined,
    hasConcern: rec.hasConcern || undefined,
    verificationNotes: out.notes.length ? out.notes : undefined,
    link: doiUrl || rec.sourceUrl || scholarSearchLink(rec.title, rec.authors[0]),
  };
}

// Evidencia del glosario: solo se enlaza una obra si existe Y coincide con la cita escrita. Nunca se sustituye por "algún paper del tema".
async function verifyGlossaryEvidence(
  rawEvidence: string | undefined,
  termName: string,
  _generalContext: string
): Promise<{ evidenceText: string; verifiedUrl?: string; status?: VerificationStatus }> {
  const text = (rawEvidence || "").trim();
  if (text.length < 5) return { evidenceText: "" };

  const titleMatch = text.match(/['"“](.*?)['"”]/);
  const rawTitle = titleMatch ? titleMatch[1] : "";
  const authorMatch = text.match(/^([A-Za-z\s,.\-&]+)\s*\(\d{4}\)/);
  const yearMatch = text.match(/\((\d{4})\)/);
  const link = scholarSearchLink(rawTitle || `${termName} ${text}`.slice(0, 100), authorMatch?.[1]?.trim());

  if (rawTitle) {
    const v = await verifyCitation(newRegistry(), { title: rawTitle, author: authorMatch?.[1]?.trim(), year: yearMatch?.[1] });
    if ((v.status === "exact" || v.status === "probable") && v.record) {
      const r = v.record;
      return {
        evidenceText: `${r.authors.slice(0, 3).join(", ")} (${r.year ?? "s. f."}). '${r.title}'.${r.venue ? " " + r.venue + "." : ""}`,
        verifiedUrl: r.doi ? `https://doi.org/${r.doi}` : link,
        status: v.status,
      };
    }
  }
  return { evidenceText: text, verifiedUrl: link, status: "not_found" };
}

// Cache database loaded from disk
const db: Record<string, AnalysisResult> = loadDatabase();

function cleanJsonParse(text: string): any {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned);
}

async function generateAnalysisContentWithRetry(
  genContents: any,
  systemInstruction: string,
  responseSchemaConfig: any,
  preferSearch: boolean = false,
  seed?: number // semilla estable por contenido: mejor esfuerzo, Google no garantiza determinismo
): Promise<string> {
  // Strategy: Try primary gemini-3.8-flash, then fallback to gemini-flash-latest, then gemini-3.1-flash-lite
  const models = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  let lastError: any = null;

  for (const model of models) {
    const configVariations = preferSearch
      ? [{ useSearch: true }, { useSearch: false }]
      : [{ useSearch: false }, { useSearch: true }];

    for (const variation of configVariations) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[Gemini Analysis] Invoking ${model} (attempt ${attempt}, search: ${variation.useSearch ? 'on' : 'off'})...`);

          const config: any = {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseSchemaConfig,
            temperature: 0.35,
          };
          if (seed !== undefined) config.seed = seed;

          if (variation.useSearch) {
            config.tools = [{ googleSearch: {} }];
          }

          const response = await ai.models.generateContent({
            model,
            contents: genContents,
            config
          });

          const rawText = response.text ? response.text.trim() : "";
          if (rawText) {
            console.log(`[Gemini Analysis] Successfully received response from ${model}`);
            return rawText;
          }
        } catch (err: any) {
          lastError = err;
          const errMsg = err?.message || String(err);
          console.warn(`[Gemini Analysis Warning] ${model} (attempt ${attempt}) encountered issue:`, errMsg);

          const is429 = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("rate-limits") || errMsg.includes("quota");
          const is503 = errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand");

          if (is429 || is503) {
            if (attempt === 1) {
              const backoffMs = 2000 + Math.random() * 1500;
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }
    }
  }

  throw lastError || new Error("No se pudo obtener respuesta de la API tras reintentos y modelos de respaldo.");
}

async function generateTextWithFallback(
  prompt: string,
  systemInstruction: string
): Promise<string> {
  const models = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  let lastErr: any = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Gemini Text] Calling ${model} (attempt ${attempt})...`);
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: 0.2,
          }
        });
        const text = response.text ? response.text.trim() : "";
        if (text) return text;
      } catch (err: any) {
        lastErr = err;
        const errMsg = err?.message || String(err);
        console.warn(`[Gemini Text Warning] ${model} attempt ${attempt} failed:`, errMsg);
        const isTransient = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("503") || errMsg.includes("UNAVAILABLE");
        if (isTransient && attempt === 1) {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
        } else {
          break;
        }
      }
    }
  }

  throw lastErr || new Error("Error al generar texto con el modelo de IA.");
}

// Grounded live web search tool for fact-checking and automated consultation
async function generateGroundedSearchText(
  prompt: string,
  systemInstruction?: string,
  opts?: { strict?: boolean } // strict: sin URLs sacadas del texto del modelo ni respaldo sin búsqueda
): Promise<{ text: string; sources: Array<{ title: string; url: string; snippet?: string }>; failed?: boolean; error?: string }> {
  const models = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  let lastErr: any = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Gemini Grounded Search] Calling ${model} (attempt ${attempt})...`);
        const config: any = {
          tools: [{ googleSearch: {} }],
          temperature: 0.1,
        };
        if (systemInstruction) config.systemInstruction = systemInstruction;

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config
        });

        const text = response.text ? response.text.trim() : "";
        if (text) {
          const sources: Array<{ title: string; url: string; snippet?: string }> = [];
          const candidate = response.candidates?.[0];
          const chunks = candidate?.groundingMetadata?.groundingChunks;
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              if (chunk.web?.uri) {
                sources.push({
                  title: chunk.web.title || "Fuente Oficial Contrastada",
                  url: chunk.web.uri,
                });
              }
            }
          }

          if (sources.length === 0 && !opts?.strict) {
            const urlMatches = text.match(/https?:\/\/[^\s)"]+/g);
            if (urlMatches) {
              urlMatches.slice(0, 5).forEach((u) => {
                sources.push({ title: "Fuente Oficial Consultada", url: u });
              });
            }
          }

          return { text, sources };
        }
      } catch (err: any) {
        lastErr = err;
        const errMsg = err?.message || String(err);
        console.warn(`[Gemini Grounded Search Warning] ${model} attempt ${attempt} failed:`, errMsg);
        // En modo estricto, una cuota DIARIA agotada no mejora esperando: se pasa al siguiente modelo (cada uno tiene su propia cuota).
        if (opts?.strict && parseGeminiError(err).quota === "day") break;
        const isTransient = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("503") || errMsg.includes("UNAVAILABLE");
        if (isTransient && attempt === 1) {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
        } else {
          break;
        }
      }
    }
  }

  // En modo estricto no se sustituye la búsqueda por texto generado de memoria: se avisa del fallo.
  if (opts?.strict) {
    const reason = String(lastErr?.message || "respuesta vacía del buscador").slice(0, 4000); // sin recortar el JSON: lleva la cuota afectada
    console.warn(`[Gemini Grounded Search] Falló en todos los modelos: ${reason.slice(0, 300)}`);
    return { text: "", sources: [], failed: true, error: reason };
  }

  // Fallback to text generation if grounded tool failed
  try {
    const plainText = await generateTextWithFallback(prompt, systemInstruction || "");
    return { text: plainText, sources: [] };
  } catch (e) {
    throw lastErr || e;
  }
}

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  if (!isAuthRequired()) {
    console.warn(`AVISO: REQUIRE_AUTH=false → la API está ABIERTA. Protecciones activas: límite por IP, tope global de ${dailyCostlyMax()} operaciones/día, anti-SSRF. Fija un tope mensual de gasto en Google AI Studio.`);
  }
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1)); // Render está detrás de un proxy

  // Cuerpo JSON acotado (los ficheros viajan en base64)
  app.use(express.json({ limit: `${MAX_BODY_MB}mb` }));
  app.use(securityHeaders);

  // Único endpoint público (sin datos): comprobación de salud para Render
  app.get("/api/health", (_req, res) => res.json({ ok: true, authRequired: isAuthRequired() }));

  // Todo lo demás bajo /api exige credencial; los intentos fallidos se limitan por IP
  app.use("/api", failedAuthLimiter, requireAuth, apiLimiter);
  app.param("id", (_req, _res, next, id) => (ID_RE.test(id) ? next() : next(new HttpError(400, "Identificador no válido."))));
  // Rutas que consumen cuota de Gemini / OpenAlex / Crossref
  app.post(
    ["/api/analyze", "/api/full-translation", "/api/analyses/:id/auto-factcheck", "/api/analyses/:id/correct", "/api/analyses/:id/switch-language"],
    costlyLimiter
  );

  // API Endpoint to fetch historical analyses
  app.get("/api/analyses", (req, res) => {
    res.json(Object.values(db).sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt)));
  });

  // API Endpoint to delete an analysis
  app.delete("/api/analyses/:id", (req, res) => {
    const { id } = req.params;
    if (db[id]) {
      delete db[id];
      saveDatabase(db);
    }
    res.json({ success: true, message: "Análisis eliminado correctamente" });
  });

  // API Endpoint to clear entire history if requested
  app.delete("/api/analyses", (req, res) => {
    if (req.get("x-confirm-delete-all") !== "yes") {
      return res.status(400).json({ error: "Borrado masivo: añade la cabecera X-Confirm-Delete-All: yes." });
    }
    Object.keys(db).forEach((k) => delete db[k]);
    saveDatabase(db);
    res.json({ success: true, message: "Histórico completo vaciado" });
  });

  // Validación síncrona previa: así el error llega a next() y se responde 400 (Express 4 no captura throws en handlers async)
  app.post("/api/analyze", (req, _res, next) => {
    try {
      validateAnalyzeBody(req.body);
      if (req.body.url) parseAndValidateUrl(req.body.url); // 400 para localhost, IPs privadas, esquemas no http(s)…
      next();
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/full-translation", (req, _res, next) => {
    try {
      if (req.body?.url) parseAndValidateUrl(req.body.url);
      next();
    } catch (e) {
      next(e);
    }
  });

  // Tope global diario: se registra DESPUÉS de las validaciones para que las peticiones inválidas no lo consuman
  app.post(
    ["/api/analyze", "/api/full-translation", "/api/analyses/:id/auto-factcheck", "/api/analyses/:id/correct", "/api/analyses/:id/switch-language"],
    dailyCostlyCap
  );

  // Main Analysis Endpoint
  app.post("/api/analyze", async (req, res) => {
    const { url, manualText, contentType, images, image, files, fresh, previous } = req.body;

    // Collect all input files (PDF, Word, Images, etc.)
    const fileList: Array<{ name?: string; type?: string; data: string }> = [];
    if (files && Array.isArray(files)) {
      fileList.push(...files.filter((f: any) => f && (f.data || typeof f === "string")));
    }
    if (images && Array.isArray(images)) {
      images.forEach((img: any) => {
        if (typeof img === "string") fileList.push({ data: img, type: "image/jpeg" });
      });
    } else if (image && typeof image === "string") {
      fileList.push({ data: image, type: "image/jpeg" });
    }

    if (!url && !manualText && fileList.length === 0) {
      return res.status(400).json({ error: "Debe proporcionar una URL, texto manual, documento (PDF, Word) o foto de un artículo." });
    }

    try {
      let textToAnalyze = manualText || "";
      let textIsFallback = false; // true si el scraping falló y solo se tiene la URL: NUNCA se congela un análisis sin texto real
      let finalUrl = url || "";
      const imageList: string[] = [];
      const documentNames: string[] = [];
      const contentParts: any[] = [];
      let extractedDocsText = "";

      for (const fileObj of fileList) {
        const dataStr = typeof fileObj === "string" ? fileObj : fileObj.data;
        const fileName = (typeof fileObj === "object" && fileObj.name) ? fileObj.name : "Archivo";
        let fileType = (typeof fileObj === "object" && fileObj.type) ? fileObj.type : "";

        if (!dataStr || typeof dataStr !== "string") continue;

        let base64Data = dataStr;
        let headerMime = "";
        if (dataStr.includes(";base64,")) {
          const [header, b64] = dataStr.split(";base64,");
          base64Data = b64;
          headerMime = header.replace("data:", "").split(";")[0] || "";
        }

        const mimeType = (headerMime || fileType).toLowerCase();
        const lowerName = fileName.toLowerCase();
        const isPdf = mimeType.includes("pdf") || lowerName.endsWith(".pdf");
        const isWord = mimeType.includes("word") || mimeType.includes("officedocument") || mimeType.includes("msword") || lowerName.endsWith(".docx") || lowerName.endsWith(".doc");
        const isImage = mimeType.startsWith("image/") || (!isPdf && !isWord && (dataStr.startsWith("data:image/") || mimeType.includes("jpeg") || mimeType.includes("png")));

        if (isPdf) {
          documentNames.push(fileName);
          try {
            const buffer = Buffer.from(base64Data, "base64");
            const parser = new PDFParse({ data: buffer });
            const textResult = await parser.getText();
            if (textResult && textResult.text) {
              extractedDocsText += `\n\n--- INICIO DEL DOCUMENTO PDF: "${fileName}" ---\n${textResult.text}\n--- FIN DEL DOCUMENTO PDF ---`;
            }
            await parser.destroy();
          } catch (pdfErr) {
            console.error("Error al extraer texto del PDF:", pdfErr);
          }
          // Also pass PDF inlineData to Gemini directly
          contentParts.push({
            inlineData: {
              mimeType: "application/pdf",
              data: base64Data
            }
          });
        } else if (isWord) {
          documentNames.push(fileName);
          try {
            const buffer = Buffer.from(base64Data, "base64");
            const result = await mammoth.extractRawText({ buffer });
            if (result && result.value) {
              extractedDocsText += `\n\n--- INICIO DEL DOCUMENTO WORD: "${fileName}" ---\n${result.value}\n--- FIN DEL DOCUMENTO WORD ---`;
            }
          } catch (wordErr) {
            console.error("Error al extraer texto de documento Word:", wordErr);
          }
        } else if (isImage) {
          imageList.push(dataStr);
          contentParts.push({
            inlineData: {
              mimeType: mimeType || "image/jpeg",
              data: base64Data
            }
          });
        }
      }

      if (extractedDocsText) {
        textToAnalyze = (textToAnalyze ? textToAnalyze + "\n\n" : "") + extractedDocsText;
      }

      let title = "Texto Manual";
      if (documentNames.length > 0) {
        title = documentNames.length === 1 ? `Documento: ${documentNames[0]}` : `Documentos: ${documentNames.join(", ")}`;
      } else if (imageList.length > 0) {
        title = "Artículo en Fotografía";
      }

      // If a URL was provided, attempt to fetch and scrape the page
      if (url) {
        try {
          let scraped = false;

          // Special handler for YouTube URLs (youtube.com, youtu.be)
          const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
          if (isYouTube) {
            try {
              let videoId = "";
              if (url.includes("youtu.be/")) {
                videoId = url.split("youtu.be/")[1]?.split("?")[0]?.split("/")[0] || "";
              } else if (url.includes("watch?v=")) {
                videoId = url.split("watch?v=")[1]?.split("&")[0] || "";
              } else if (url.includes("/shorts/")) {
                videoId = url.split("/shorts/")[1]?.split("?")[0]?.split("/")[0] || "";
              } else if (url.includes("/embed/")) {
                videoId = url.split("/embed/")[1]?.split("?")[0]?.split("/")[0] || "";
              } else if (url.includes("/live/")) {
                videoId = url.split("/live/")[1]?.split("?")[0]?.split("/")[0] || "";
              }

              // 1. Fetch YouTube oEmbed API for verified official title and channel name
              const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
              const oembedRes = await fetch(oembedUrl, {
                headers: { "Accept": "application/json" }
              });
              let videoTitle = "";
              let channelName = "";
              let channelUrl = "";

              if (oembedRes.ok) {
                const oembedData: any = await oembedRes.json();
                if (oembedData) {
                  videoTitle = oembedData.title || "";
                  channelName = oembedData.author_name || "";
                  channelUrl = oembedData.author_url || "";
                  if (videoTitle) {
                    title = videoTitle;
                  }
                }
              }

              // 2. Attempt to fetch subtitles/transcript if available
              let transcriptText = "";
              if (videoId) {
                try {
                  const { YoutubeTranscript } = await import("youtube-transcript");
                  if (YoutubeTranscript && typeof YoutubeTranscript.fetchTranscript === "function") {
                    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
                    if (Array.isArray(transcriptItems) && transcriptItems.length > 0) {
                      transcriptText = transcriptItems.map((t: any) => t.text).join(" ");
                    }
                  }
                } catch (trErr) {
                  // Transcript may be disabled or video has no speech
                }
              }

              // 3. Build rich context for Gemini
              let ytContext = `--- RECURSO MULTIMEDIA DE YOUTUBE ---\n`;
              ytContext += `Título Oficial del Vídeo: "${videoTitle || title}"\n`;
              if (channelName) ytContext += `Canal / Creador: "${channelName}" (${channelUrl})\n`;
              ytContext += `URL Oficial: ${url}\n`;
              if (videoId) ytContext += `ID del Vídeo: ${videoId}\n`;

              if (transcriptText) {
                ytContext += `\nTranscripción completa del audio / subtítulos del vídeo:\n${transcriptText}\n`;
              } else {
                ytContext += `\nNota: Este vídeo es un recurso audiovisual/tutorial/demostración (sin subtítulos hablados o con música/instrucción visual directa). El análisis DEBE centrarse con total precisión en el tema de ESTE VÍDEO ("${videoTitle || title}" del canal "${channelName || 'el autor'}") y sus técnicas, metodología, conceptos y disciplina correspondiente.\n`;
              }
              ytContext += `--- FIN DEL RECURSO DE YOUTUBE ---`;

              textToAnalyze = ytContext;
              scraped = true;
            } catch (ytErr) {
              console.warn("YouTube handler error, falling back to generic fetch:", ytErr);
            }
          }

          // Special handler for Substack URLs (e.g. https://elarjonauta.substack.com/p/la-ia-china-o-el-arte-de-no-ser-gobernados?r=5h3vek)
          if (!scraped && url.includes("substack.com/p/")) {
            try {
              const parsed = new URL(url);
              const pathParts = parsed.pathname.split("/p/");
              if (pathParts.length > 1) {
                const slug = pathParts[1].split("/")[0].split("?")[0];
                const apiUrl = `https://${parsed.host}/api/v1/posts/${slug}`;
                const subRes = await safeFetch(apiUrl, {
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "application/json"
                  }
                });
                if (subRes.ok) {
                  const subData: any = await subRes.json();
                  if (subData) {
                    title = subData.title || title;
                    const subtitle = subData.subtitle || subData.description || "";
                    const htmlContent = subData.body_html || "";
                    if (htmlContent) {
                      const $sub = cheerio.load(htmlContent);
                      $sub("script, style, iframe, noscript, svg").remove();
                      const cleanBody = $sub.text().trim();
                      if (cleanBody.length > 100) {
                        textToAnalyze = `Título: ${title}\nSubtítulo: ${subtitle}\n\n${cleanBody}`;
                        scraped = true;
                      }
                    }
                  }
                }
              }
            } catch (subErr) {
              console.warn("Substack API endpoint failed, falling back to standard HTML scraper:", subErr);
            }
          }

          if (!scraped) {
            const response = await safeFetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
              }
            });

            if (!response.ok) {
              throw new Error(`Error al acceder a la URL (${response.status} ${response.statusText})`);
            }

            const html = await response.text();
            const $ = cheerio.load(html);

            // Extract title
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const pageTitle = $("h1").first().text().trim() || $("title").text().trim();
            title = ogTitle || pageTitle || "Contenido de Internet";

            // Clean up page noise
            $("script, style, header, footer, nav, iframe, noscript, svg, .subscription-widget-wrap, .comments-section").remove();

            // Extract content from Substack / blogs / articles
            let bodyText = "";
            const selectors = ["article", ".post-content", ".available-content", ".body.markup", ".pencraft", ".markup", ".entry-content", "main"];
            
            for (const selector of selectors) {
              const text = $(selector).text().trim();
              if (text.length > 300) {
                bodyText = text;
                break;
              }
            }

            if (!bodyText) {
              const paragraphs = $("p").map((_, el) => $(el).text()).get();
              bodyText = paragraphs.join("\n\n");
              if (bodyText.length < 200) {
                bodyText = $("body").text().trim();
              }
            }

            const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || "";
            if (ogDesc && !bodyText.includes(ogDesc)) {
              bodyText = `Descripción del artículo: ${ogDesc}\n\n${bodyText}`;
            }

            textToAnalyze = bodyText.substring(0, 45000);
          }
        } catch (scrapeErr: any) {
          if (scrapeErr instanceof UnsafeUrlError) throw scrapeErr; // p. ej. redirección a IP privada → 400
          console.error("Error scraping URL, will rely on prompt context:", scrapeErr);
          textToAnalyze = `Analiza este ensayo o artículo de internet de la URL: ${url}. Título del recurso: ${title || url}`;
          textIsFallback = true;
        }
      }

      if (contentParts.length === 0 && (!textToAnalyze || textToAnalyze.trim().length < 10)) {
        return res.status(400).json({ error: "No se pudo extraer suficiente contenido, documento o imagen para analizar." });
      }

      const detectedLang = detectLanguage(`${manualText || ""} ${textToAnalyze || ""}`);

      // Estabilidad: si este mismo contenido ya se analizó con esta versión del pipeline, se reutiliza la capa auditada.
      const freezeKey = contentParts.length === 0 && !textIsFallback && (textToAnalyze || "").length >= MIN_FREEZE_CHARS ? contentHash(textToAnalyze) : null;
      const version = pipelineVersion();
      if (freezeKey && fresh !== true) {
        const reusable = findReusable([...Object.values(db), previous], CACHE_SECRET, freezeKey, version);
        if (reusable && typeof reusable.id === "string" && ID_RE.test(reusable.id)) {
          if (!db[reusable.id]) {
            db[reusable.id] = reusable;
            saveDatabase(db);
          }
          console.log(`[Estabilidad] Contenido ya analizado (${freezeKey.slice(0, 8)}): se reutiliza ${reusable.id}.`);
          return res.json({ ...reusable, reused: true });
        }
      }
      const seed = freezeKey ? seedFromHash(freezeKey) : undefined;
      const isGalego = detectedLang === "galego";
      const isCatala = detectedLang === "català";

      // Detect if user query involves elections, seats, political parties, or factual queries
      const isFactualElectionQuery = /elecci|escan|voto|diputa|candidat|resultado|mellor|mejor|hist[oó]ri|quene|qui[eé]n|bng|partid/i.test(`${manualText || ""} ${textToAnalyze || ""}`);

      const systemInstruction = `
Eres un analista crítico, epistemólogo y catedrático universitario de alto nivel, experto en verificar la veracidad, evaluar el rigor metodológico y deconstruir contenidos de internet, artículos en periódicos impresos o digitales, recortes de prensa, libros, podcasts y ensayos académicos.

*** REGLA FUNDAMENTAL DE FIDELIDAD LINGÜÍSTICA ESTRICTA (IDIOMA DE RESPUESTA) ***
${isGalego ? `
- IDIOMA VEHICULAR OBRIGATORIO: GALEGO (LINGUA GALEGA).
- O usuario formulou a súa consulta ou achegou o material en LINGUA GALEGA.
- POLO TANTO, É TOTALMENTE OBRIGATORIO que ABSOLUTAMENTE TODO o informe xerado estea redactado en GALEGO correcto, formal, normativo e universitario:
  * 'originalTitle': En galego correcto (ou o título oficial).
  * 'executiveSummary': ÍNTEGRAMENTE en galego normativo, formal e universitario.
  * 'keyPoints': Todos os puntos clave redactados estritamente en galego.
  * 'numericalExamples': Conceptos e explicacións detalladas en galego con cifras reais e rigor estatístico.
  * 'criticalPositions': Posicións críticas e fundamentos metodolóxicos en galego.
  * 'constructiveDebatesSummary': Síntese do debate en galego.
  * 'academicDebates': Análise de debates académicos vixentes en galego.
  * 'glossary': Termos, definicións e exemplos en galego.
  * ESTÁ TERMINANTEMENTE PROHIBIDO responder en castelán cando a consulta se fixo en galego! Respéctase ao 100% a lingua galega do usuario.
` : isCatala ? `
- IDIOMA VEHICULAR OBLIGATORI: CATALÀ.
- Redacta absolutament tot l'informe en català normatiu i formal.
` : `
- IDIOMA VEHICULAR: Español (castellano) universitario, formal y riguroso.
`}

*** RIGOR FÁCTICO ***
- No afirmes cifras, fechas, cargos, resultados ni hechos históricos de los que no estés seguro. Si no lo estás, dilo y formula la duda como algo a comprobar.
- Cuando atribuyas cifras o resultados a una fuente, no completes la serie de memoria: limítate a lo que consta en el texto o a lo que conozcas con certeza.

Instrucciones detalladas de análisis:
1. **Vídeos de YouTube, Podcasts y Multimedia**:
   - Analiza con máxima fidelidad el contenido temático, título y autor del vídeo o podcast suministrado.
   - Adapta las disciplinas, categorías, resumen y glosario a la materia real del contenido (e.g. Bellas Artes, Pintura/Acuarela, Ciencia de Materiales, Economía, Filosofía, etc.).
   - Si el título original está en inglés (e.g. "Easy Loose Watercolor Bird of Paradise"), traduce el título o indícalo en el idioma del informe ("Acuarela fácil y suelta: Ave del paraíso") y genera en 'translation' la traducción/transcripción de las instrucciones y técnicas explicadas.

2. **Fotografías y Recortes de Prensa / Periódicos (OCR y Deconstrucción)**:
   - Si se adjuntan fotos de periódicos, revistas o documentos impresos (OCR multimodal):
     * Transcribe y lee íntegramente todo el cuerpo de texto visible en la imagen, incluyendo titulares principales, antetítulos, subtítulos, pies de foto, datos de recuadros e infografías (p. ej., cifras numéricas, millones de euros, desgloses presupuestarios) y nombres de autores o medios impresos (p. ej., 'La Voz de Galicia', 'Gabriel Lemos', 'M. Dávila', etc.).
     * Asigna a 'originalTitle' el título o titular exacto y completo del artículo de prensa capturado en la foto.
     * Extrae de forma explícita el análisis metodológico, socioeconómico, técnico o científico expresado en la noticia.

3. **Idioma y Traducción / Transcripción ÍNTEGRA Y COMPLETA (SIN RESUMIR NI OMITIR)**:
   - Identifica con precisión el idioma original.
   - **MÁXIMA EXHAUSTIVIDAD Y FIDELIDAD EN LA TRADUCCIÓN**: Si el contenido no está en castellano o gallego (p. ej. inglés, francés, alemán, o si es un vídeo de YouTube, podcast o artículo de prensa en otro idioma), la propiedad 'translation' **DEBE CONTENER LA TRADUCCIÓN ÍNTEGRA, COMPLETA Y EXHAUSTIVA DE TODO EL TEXTO ORIGINAL PÁRRAFO POR PÁRRAFO O INSTRUCCIÓN POR INSTRUCCIÓN**.
   - **PROHIBICIÓN TOTAL DE CONDENSAR O ABREVIAR**: Queda terminantemente prohibido resumir, sintetizar o saltarse secciones o párrafos intermedios. El usuario debe poder leer la obra, tutorial, discurso o artículo entero de principio a fin, preservando todos los detalles, cifras, declaraciones y matices. Si el original ya está en castellano o gallego, la propiedad 'translation' puede omitirse o ser nula.

4. **Categorización**:
   - Clasifica el material por temas o disciplinas intelectuales precisas (e.g., Economía Pública, Defensa y Geopolítica, Psicología Social, Epistemología Evolutiva, Sociología Política, Filosofía de la Mente). Máximo 3 categorías.

5. **Resumen Ejecutivo Profundo**:
   - Escribe un resumen ejecutivo automático que deconstruya la tesis central, los datos empíricos/económicos/científicos presentados, el marco teórico empleado por el autor y las conclusiones principales con lenguaje formal y pedagógico en el idioma de respuesta.

6. **Puntos Clave y Argumentos Fundamentales**:
   - Extrae entre 5 y 8 puntos clave esenciales que vertebren la argumentación lógica o el informe del texto/periódico.

7. **Ejemplos numéricos explicativos (solo si el texto aporta cifras o magnitudes)**:
   - Si el texto maneja cifras, costes, proporciones o plazos, traduce los conceptos técnicos a ejemplos numéricos claros y tangibles usando EXCLUSIVAMENTE datos presentes en el texto o cifras que conozcas con certeza (indica de dónde proceden). No inventes cifras para completar.
   - Si el texto no contiene cifras o no hay datos fiables, devuelve una lista vacía.

8. **Resumen de Debates Actuales y Consensos Científicos/Académicos**:
   - Elabora un análisis exhaustivo y didáctico del estado actual del debate intelectual, científico o técnico.
   - Debes delimitar con total claridad:
     a) **overview**: Visión general del estado actual de la discusión.
     b) **keyQuestions**: Entre 3 y 5 preguntas o dilemas abiertos sobre los que aún se investiga o debate.
     c) **consensusAndDisagreements**: Detalla explícitamente consensos y puntos de desacuerdo.

9. **Posiciones críticas (contraargumentación rigurosa y constructiva)**:
   - Formula de 0 a 5 posiciones críticas, solo las que el texto justifique. Si el texto es sólido o no hay base para criticar, devuelve menos posiciones o ninguna. No rellenes.
   - Cada posición debe apuntar a una afirmación CONCRETA del texto: copia en 'targetClaim' una frase LITERAL (máx. 25 palabras) del texto analizado. Si no puedes copiarla literalmente, no formules esa posición.
   - Antes de criticar, adopta la actitud de explorador: ¿qué acierta el autor?, ¿cuál es la versión más fuerte de su tesis? Critica esa versión fuerte, no una caricatura.
   - Indica en 'critiqueType' el tipo de crítica: definicion_perimetro (qué mide realmente una cifra, qué incluye y qué excluye, cómo se financia cada partida), medicion, causal, institucional_contable, empirica, logica o normativa.
   - Revisa siempre la validez conceptual de las cifras: perímetro y definición de la magnitud (qué agrega; si suma partidas de distinta naturaleza o de distinta fuente de financiación y si la conclusión depende de ello), numerador y denominador, valores nominales o reales, agregado o per cápita, fechas elegidas, y comparabilidad entre fuentes con definiciones distintas.
   - No afirmes como hecho algo institucional, contable o legal de lo que no estés seguro: formúlalo como pregunta o hipótesis a comprobar. En 'evidenceThatWouldSettleIt' indica qué dato o documento lo resolvería, y en 'suggestedSources' los nombres de las instituciones o bases de datos que lo publican (solo nombres, nunca enlaces inventados).
   - 'empiricalStudy' es OPCIONAL: inclúyelo solo si recuerdas con certeza un estudio real que trate específicamente ese argumento (título, autor y año exactos; DOI si lo conoces). Si no, OMÍTELO. Un estudio del mismo campo pero sobre otro asunto NO sirve. Se comprobará en registros académicos y se descartará si no existe o no trata el argumento.
   - Si la evidencia disponible no basta para sostener la crítica, dilo en 'scientificBasis' (evidencia insuficiente) en vez de forzar una justificación.

10. **Debates Académicos e Intelectuales Vigentes**:
   - Sitúa la tesis del artículo dentro del contexto histórico, escuelas de pensamiento rivales e implicaciones socioeconómicas o geopolíticas contemporáneas.

11. **Fuentes bibliográficas de contraste (opcional)**:
   - Incluye de 0 a 5 fuentes, solo las que conozcas con certeza y que traten específicamente los asuntos del texto. Si no hay literatura suficiente o no la recuerdas con certeza, devuelve la lista vacía: es una respuesta válida y preferible a inventar.
   - No inventes títulos, autores, años ni DOI. Si no recuerdas la referencia exacta, no la incluyas. Todas se comprobarán en Crossref y OpenAlex; las que no existan o no coincidan se marcarán como no verificadas.
   - Para informes de organismos oficiales sin DOI (Comisión Europea, OCDE, FMI, bancos centrales, institutos de estadística...) indica en 'url' la dirección exacta SOLO si la conoces con certeza: se comprobará que la página contiene el título citado y se descartará si no.
   - La antigüedad no es un criterio de calidad: un estudio clásico bien replicado vale más que un preprint reciente. No priorices ni excluyas por fecha.
   - Indica en 'studyDesign' el diseño del estudio: systematic_review, rct, cohort, case_control, cross_sectional, case_series, expert_opinion, modeling_theory o unknown.

12. **Glosario didáctico (solo los términos necesarios)**:
   - Genera de 0 a 8 términos técnicos, metodológicos, económicos o filosóficos complejos que el lector necesite para entender el texto.
   - Para cada término aporta:
     a) 'term': nombre exacto del concepto.
     b) 'definition': definición accesible y rigurosa (nivel universitario sin jerga innecesaria).
     c) 'simpleExample': un caso práctico. Si conoces con certeza un precedente real y verificable, cuéntalo con sus consecuencias medibles; si no, usa un ejemplo numérico hipotético y ETIQUÉTALO como "ejemplo ilustrativo (hipotético)". Nunca presentes como histórico algo que no sepas con certeza.
     d) 'scientificEvidenceOrSource' (OPCIONAL): cita bibliográfica solo si la conoces con certeza (autores, año exacto, título exacto y revista o institución). Si no, déjalo vacío: no inventes ni sustituyas por un trabajo parecido. Se comprobará en registros académicos.
     e) 'referenceUrl': déjalo vacío salvo que conozcas con certeza la URL exacta; el sistema generará un enlace de búsqueda.

13. **Evaluación de explorador (scout)**:
   - 'whereAuthorIsRight': de 2 a 4 puntos donde el texto acierta o aporta valor.
   - 'strongestVersion': la versión más sólida de la tesis del autor, en 1 a 3 frases.
   - 'implicationsIfTrue': de 2 a 4 implicaciones si la tesis fuera cierta.
   - 'whatWouldChangeTheConclusion': de 2 a 4 datos o evidencias concretas que cambiarían la conclusión.
   - 'evidenceSufficiency': suficiente, parcial o insuficiente respecto a lo que el texto afirma, con una nota breve en 'sufficiencyNote'. Concluir "insuficiente" es legítimo.
`;

      let userPrompt = "";
      if (imageList.length > 0) {
        userPrompt = `
Has recibido ${imageList.length} fotografía(s) de un artículo de prensa, periódico, revista o documento impreso.
Lee y transcribe minuciosamente el texto impreso, las cabeceras, subtítulos, pies de foto y los datos estadísticos visibles en la(s) foto(s).
Lleva a cabo la deconstrucción crítica, traducción/transcripción íntegra al castellano, análisis epistemológico, fuentes bibliográficas solo si las conoces con certeza, y glosario pedagógico en castellano.
${manualText ? `Notas o contexto adicional proporcionado por el usuario: "${manualText}"` : ""}
`;
      } else {
        userPrompt = `
Título detectado: "${title}"
URL del contenido: "${finalUrl}"
Tipo de contenido: "${contentType || "blog"}"

Texto extraído o referencia:
${textToAnalyze}
`;
      }

      // Notas de contexto curadas: solo se activan si el texto trata ese asunto; la comprobación de "qué reconoce el texto" es determinista
      const contextNotes = matchContextNotes(textToAnalyze || "");
      if (contextNotes.length > 0) userPrompt += `\n\n${renderNotesForPrompt(contextNotes)}\n`;

      const responseSchemaConfig = {
        type: Type.OBJECT,
        properties: {
          originalTitle: { type: Type.STRING },
          originalLanguage: { type: Type.STRING },
          isSpanishOrGalician: { type: Type.BOOLEAN },
          categories: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Categorías temáticas (máximo 3, e.g., Psicología Social, Epistemología)."
          },
          translation: { 
            type: Type.STRING, 
            description: "Traducción y transcripción 100% ÍNTEGRA, COMPLETA y EXHAUSTIVA de TODO el contenido original de principio a fin al castellano (párrafo por párrafo, sin resumir ni omitir fragmentos) si el original no está en español o gallego." 
          },
          executiveSummary: { 
            type: Type.STRING, 
            description: "Resumen ejecutivo formal, estructurado, pedagógico y claro (nivel universitario)." 
          },
          keyPoints: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Puntos clave y argumentos más importantes del texto/vídeo (5 a 8 puntos)." 
          },
          numericalExamples: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                concept: { type: Type.STRING, description: "Nombre del concepto o dato técnico/económico." },
                figureOrCost: { type: Type.STRING, description: "Cifra real, coste ($M/$K), plazo o proporción relevante." },
                explanation: { type: Type.STRING, description: "Explicación sencilla, intuitiva y con ejemplo o cálculo simplificado." }
              },
              required: ["concept", "figureOrCost", "explanation"]
            },
            description: "De 0 a 6 ejemplos numéricos basados SOLO en cifras del texto o conocidas con certeza. Lista vacía si no hay cifras fiables."
          },
          criticalPositions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: "Título de la posición crítica." },
                argument: { type: Type.STRING, description: "Exposición clara del argumento crítico, referida a la afirmación concreta del texto." },
                scientificBasis: { type: Type.STRING, description: "Fundamento metodológico, empírico o teórico. Si la evidencia no basta, indícalo (evidencia insuficiente)." },
                targetClaim: { type: Type.STRING, description: "Frase LITERAL (máx. 25 palabras) del texto analizado a la que apunta la crítica." },
                critiqueType: { type: Type.STRING, enum: ["definicion_perimetro", "medicion", "causal", "institucional_contable", "empirica", "logica", "normativa"] },
                evidenceThatWouldSettleIt: { type: Type.STRING, description: "Qué dato o documento resolvería la duda y quién lo publica." },
                suggestedSources: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Nombres de instituciones o bases de datos a consultar. Sin enlaces." },
                contextNoteIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Ids de las NOTAS DE CONTEXTO en las que se apoya esta posición, si las hay." },
                empiricalStudy: {
                  type: Type.OBJECT,
                  description: "OPCIONAL: solo si recuerdas con certeza un estudio real que trate específicamente este argumento.",
                  properties: {
                    title: { type: Type.STRING, description: "Título exacto del estudio." },
                    author: { type: Type.STRING, description: "Autor/es principales." },
                    year: { type: Type.STRING, description: "Año de publicación." },
                    doi: { type: Type.STRING, description: "DOI si lo conoces con certeza; si no, vacío." },
                    url: { type: Type.STRING, description: "URL exacta de un informe institucional, solo si la conoces con certeza; si no, vacío." }
                  },
                  required: ["title", "author"]
                }
              },
              required: ["title", "argument", "scientificBasis", "targetClaim"]
            },
            description: "De 0 a 5 posiciones críticas. Lista vacía si el texto no da base para criticar."
          },
          constructiveDebatesSummary: {
            type: Type.OBJECT,
            properties: {
              overview: { type: Type.STRING, description: "Síntesis del panorama del debate constructivo expresado de forma clara para estudiantes." },
              keyQuestions: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "Preguntas abiertas o dilemas clave en la discusión (3 a 5 preguntas)." 
              },
              consensusAndDisagreements: { type: Type.STRING, description: "Puntos de consenso y discrepancias metodológicas/teóricas." }
            },
            required: ["overview", "keyQuestions"]
          },
          academicDebates: {
            type: Type.STRING,
            description: "Análisis exhaustivo y minucioso de los debates académicos e intelectuales vigentes sobre el tema."
          },
          glossary: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING, description: "Concepto o término técnico/filosófico/científico." },
                definition: { type: Type.STRING, description: "Definición accesible, clara y didáctica (nivel universitario)." },
                simpleExample: { type: Type.STRING, description: "Ejemplo o caso práctico sustancial, detallado y rigurosamente documentado (evita metáforas simplistas). Explica cómo opera en la práctica o qué ocurrió históricamente/empíricamente cuando se aplicó o ignoró este concepto en casos reales (p. ej. decisiones de bancos centrales, políticas públicas, experimentos científicos) y qué consecuencias medibles provocó." },
                scientificEvidenceOrSource: { type: Type.STRING, description: "Evidencia empírica contrastada, estudio seminal o documento institucional contrastado (autores, año, publicación/organismo) donde se verificó y probó este concepto en la realidad y dónde consultarlo." },
                referenceUrl: { type: Type.STRING, description: "URL de referencia confiable o búsqueda educativa (e.g. Google Scholar, Wikipedia, Stanford Encyclopedia)." }
              },
              required: ["term", "definition", "simpleExample", "referenceUrl"]
            },
            description: "Glosario didáctico de 4 a 8 conceptos complejos con ejemplos intuitivos y fuentes científicas contrastadas."
          },
          bibliographicSources: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: "Título EXACTO de una obra que conozcas con certeza, en su idioma original." },
                author: { type: Type.STRING, description: "Autor/es principales o institución." },
                year: { type: Type.STRING, description: "Año de publicación." },
                doi: { type: Type.STRING, description: "DOI si lo conoces con certeza; si no, vacío." },
                url: { type: Type.STRING, description: "Para informes de organismos oficiales sin DOI: URL exacta solo si la conoces con certeza; si no, vacío." },
                type: { type: Type.STRING, description: "Tipo de recurso (artículo, libro, informe, metaanálisis...)." },
                studyDesign: { type: Type.STRING, enum: ["systematic_review", "rct", "cohort", "case_control", "cross_sectional", "case_series", "expert_opinion", "modeling_theory", "unknown"] },
                summary: { type: Type.STRING, description: "Qué plantea esta fuente, según recuerdas." },
                criticalAnalysis: { type: Type.STRING, description: "Cómo se relaciona con la tesis del texto. Será comprobado contra el resumen real de la obra." }
              },
              required: ["title", "author", "year", "type", "summary", "criticalAnalysis"]
            },
            description: "De 0 a 5 fuentes que conozcas con certeza. Lista vacía si no hay literatura suficiente o no la recuerdas."
          },
          scoutAssessment: {
            type: Type.OBJECT,
            properties: {
              whereAuthorIsRight: { type: Type.ARRAY, items: { type: Type.STRING } },
              strongestVersion: { type: Type.STRING },
              implicationsIfTrue: { type: Type.ARRAY, items: { type: Type.STRING } },
              whatWouldChangeTheConclusion: { type: Type.ARRAY, items: { type: Type.STRING } },
              evidenceSufficiency: { type: Type.STRING, enum: ["suficiente", "parcial", "insuficiente"] },
              sufficiencyNote: { type: Type.STRING }
            },
            required: ["whereAuthorIsRight", "strongestVersion", "whatWouldChangeTheConclusion", "evidenceSufficiency"]
          }
        },
        required: ["originalTitle", "originalLanguage", "isSpanishOrGalician", "categories", "translation", "executiveSummary", "keyPoints", "numericalExamples", "criticalPositions", "constructiveDebatesSummary", "academicDebates", "glossary", "bibliographicSources"]
      };

      let responseText = "";

      try {
        const genContents = contentParts.length > 0
          ? { parts: [...contentParts, { text: userPrompt }] }
          : userPrompt;

        responseText = await generateAnalysisContentWithRetry(
          genContents,
          systemInstruction,
          responseSchemaConfig,
          isFactualElectionQuery,
          seed
        );
      } catch (genErr: any) {
        console.error("Gemini generation error:", genErr);
        throw genErr;
      }

      if (!responseText) {
        throw new Error("No se obtuvo respuesta del modelo de Inteligencia Artificial.");
      }

      const result = cleanJsonParse(responseText);

      const contextKeywords = [result.originalTitle || title, ...(result.categories || [])].filter(Boolean).join(" ");

      // Fase 1: cada cita se comprueba en tres niveles (existe · coincide · respalda). Ver server/citations.ts.
      const rawCritical: any[] = result.criticalPositions || [];
      const rawSources: any[] = result.bibliographicSources || [];
      const citeInputs: CitationInput[] = [
        ...rawCritical.map((c, i): CitationInput => ({
          id: `p${i}`,
          claim: `${c.title || ""}. ${c.argument || ""}`.trim(),
          cited: c.empiricalStudy?.title ? { title: c.empiricalStudy.title, author: c.empiricalStudy.author, year: c.empiricalStudy.year, doi: c.empiricalStudy.doi, url: c.empiricalStudy.url } : undefined,
          relatedQuery: `${c.title || ""} ${(result.categories || []).join(" ")}`.trim().slice(0, 160),
          dropIfUnrelated: true,
        })),
        ...rawSources.map((src, i): CitationInput => ({
          id: `s${i}`,
          claim: (src.criticalAnalysis || src.summary || src.title || "").slice(0, 600),
          cited: { title: src.title || "", author: src.author, year: src.year, doi: src.doi, url: src.url },
          dropIfUnrelated: false,
        })),
      ];
      let citeOutputs: CitationOutput[] = [];
      try {
        citeOutputs = await resolveCitations(
          newRegistry(),
          (prompt, system, schema) => generateAnalysisContentWithRetry(prompt, system, schema, false, seed),
          citeInputs,
          detectedLang,
          { fetchPage: pageFetcher }
        );
      } catch (citeErr) {
        console.error("Error verificando citas (se muestran como no verificadas):", citeErr);
      }
      const citeById = new Map(citeOutputs.map((o) => [o.id, o]));

      const sanitizedCriticalPositions: CriticalPosition[] = rawCritical.map((crit, i) => {
        const o = citeById.get(`p${i}`);
        const quote = typeof crit.targetClaim === "string" ? crit.targetClaim.trim() : "";
        const located = !!quote && !!textToAnalyze && locateFragment(quote, textToAnalyze);
        return {
          title: crit.title || "",
          argument: crit.argument || "",
          scientificBasis: crit.scientificBasis || "",
          targetClaim: located ? quote : undefined, // una cita "literal" que no está en el texto no se muestra
          targetClaimLocated: quote ? located : undefined,
          critiqueType: crit.critiqueType || undefined,
          evidenceThatWouldSettleIt: crit.evidenceThatWouldSettleIt || undefined,
          suggestedSources: Array.isArray(crit.suggestedSources) ? crit.suggestedSources.filter((x: any) => typeof x === "string" && x.trim()).slice(0, 4) : undefined,
          contextNoteIds: Array.isArray(crit.contextNoteIds) ? crit.contextNoteIds.filter((id: any) => contextNotes.some((n) => n.id === id)) : undefined, // solo ids de notas realmente activadas
          supportingStudy: o?.record ? toCitationView(o.record, o) : undefined,
          studyDiscardedNote: o?.discarded ? `El estudio que propuso el modelo («${o.discarded.title}») se descartó: ${o.discarded.reason}.` : undefined,
        };
      });

      const sanitizedSources: BibliographicSource[] = rawSources.map((src, i) => {
        const o = citeById.get(`s${i}`);
        const design = (src.studyDesign || "unknown") as StudyDesign;
        const yearNum = parseInt(String(o?.record?.year ?? src.year ?? ""), 10);
        const displayYear = o?.record?.year ? String(o.record.year) : src.year || "s. f.";
        if (o?.record && (o.status === "exact" || o.status === "probable")) {
          const view = toCitationView(o.record, o);
          const rel = scoreReliability(o.record, o.status, design);
          return {
            title: view.title,
            author: o.record.authors.length ? view.author : `${src.author || "—"} (según el modelo)`,
            year: displayYear,
            type: src.type || "Fuente académica",
            link: view.link,
            summary: src.summary || "",
            criticalAnalysis: src.criticalAnalysis || "",
            reliabilityScore: rel.score,
            reliabilityBasis: rel.basis,
            academicRigor: rel.basis.join(" · "),
            doi: view.doi,
            journalOrVenue: view.journalOrVenue,
            citationsCount: view.citationsCount,
            openAccessUrl: view.openAccessUrl,
            isVerified: o.status === "exact",
            verificationStatus: o.status,
            supportVerdict: o.support,
            supportQuote: o.supportQuote,
            isRetracted: view.isRetracted,
            hasConcern: view.hasConcern,
            verificationNotes: view.verificationNotes,
            isRecent: !isNaN(yearNum) ? yearNum >= 2021 : undefined,
            currencyTag: `📅 ${displayYear}`, // la recencia no es calidad: etiqueta neutra
          };
        }
        // No verificada: se conserva lo que dijo el modelo, sin sello ni puntuación, y con enlace de búsqueda
        return {
          title: src.title || "",
          author: src.author || "",
          year: displayYear,
          type: src.type || "Fuente académica",
          link: scholarSearchLink(src.title || "", String(src.author || "").split(",")[0]),
          summary: src.summary || "",
          criticalAnalysis: src.criticalAnalysis || "",
          reliabilityScore: null,
          reliabilityBasis: ["No evaluable: la obra no se localizó o no coincide con ningún registro académico."],
          academicRigor: "No verificada: no se ha localizado una obra que coincida con esta cita en Crossref, OpenAlex ni en la página indicada. Los informes de organismos y la literatura gris suelen no estar indexados; esto no significa que no exista, sino que la app no ha podido comprobarlo.",
          isVerified: false,
          verificationStatus: "not_found",
          verificationNotes: o?.notes?.length ? o.notes : undefined,
          currencyTag: `📅 ${displayYear}`,
        };
      });

      const rawGlossary = result.glossary || [];
      const sanitizedGlossary: GlossaryTerm[] = [];

      for (const g of rawGlossary) {
        const verifiedEv = await verifyGlossaryEvidence(g.scientificEvidenceOrSource, g.term || "", contextKeywords);
        // Las URL escritas por el modelo pueden estar rotas o inventadas: no se usan nunca. Solo se enlaza una obra verificada;
        // en cualquier otro caso, un enlace de búsqueda etiquetado como tal.
        const isVerifiedRef = (verifiedEv.status === "exact" || verifiedEv.status === "probable") && !!verifiedEv.verifiedUrl;
        const cleanRef = isVerifiedRef ? (verifiedEv.verifiedUrl as string) : scholarSearchLink(g.term || "");
        sanitizedGlossary.push({
          term: g.term || "",
          definition: g.definition || "",
          simpleExample: g.simpleExample || "",
          scientificEvidenceOrSource: verifiedEv.evidenceText || g.scientificEvidenceOrSource || undefined,
          evidenceVerification: verifiedEv.status,
          referenceKind: isVerifiedRef ? "verified" : "search",
          referenceUrl: cleanRef
        });
      }

      const isDoc = documentNames.length > 0;
      const isPhoto = imageList.length > 0 && documentNames.length === 0;

      // Fiabilidad global: media de las fuentes VERIFICADAS con puntuación evaluable; si no hay ninguna, no se inventa un número.
      const scored = sanitizedSources.filter((x) => typeof x.reliabilityScore === "number") as Array<BibliographicSource & { reliabilityScore: number }>;
      const overallReliabilityScore: number | null = scored.length > 0 ? Math.round(scored.reduce((acc, x) => acc + x.reliabilityScore, 0) / scored.length) : null;

      // Construct the final analysis structure
      const analysisId = "analysis_" + Date.now();
      const analysis: AnalysisResult = {
        id: analysisId,
        url: finalUrl,
        title: result.originalTitle || title,
        originalLanguage: result.originalLanguage || "Desconocido",
        outputLanguage: detectedLang,
        isSpanishOrGalician: result.isSpanishOrGalician ?? true,
        categories: result.categories || [],
        translation: result.translation || undefined,
        originalExtractedText: textToAnalyze || undefined,
        executiveSummary: result.executiveSummary || "",
        keyPoints: result.keyPoints || [],
        numericalExamples: result.numericalExamples || [],
        criticalPositions: sanitizedCriticalPositions,
        constructiveDebatesSummary: result.constructiveDebatesSummary || undefined,
        academicDebates: result.academicDebates || "",
        glossary: sanitizedGlossary,
        bibliographicSources: sanitizedSources,
        scoutAssessment: sanitizeScout(result.scoutAssessment),
        contextNotes: contextNotes.length ? contextNotes : undefined,
        analyzedAt: new Date().toISOString(),
        contentType: isDoc ? "document" : (isPhoto ? "photo" : (contentType || "blog")),
        photoUrls: imageList.length > 0 ? imageList : undefined,
        fileNames: documentNames.length > 0 ? documentNames : undefined,
        overallReliabilityScore: overallReliabilityScore
      };

      if (freezeKey) analysis.frozen = signAnalysis(CACHE_SECRET, analysis, freezeKey, version);

      // Save in our persistent database
      db[analysisId] = analysis;
      saveDatabase(db);

      res.json(analysis);

    } catch (err: any) {
      if (err instanceof UnsafeUrlError) return res.status(400).json({ error: err.message });
      console.error("Error durante el análisis:", err);
      let userErrMsg = err.message || "Error interno del servidor al analizar el contenido.";
      
      if (userErrMsg.includes("429") || userErrMsg.includes("RESOURCE_EXHAUSTED") || userErrMsg.includes("rate-limits")) {
        userErrMsg = "Se ha alcanzado temporalmente el límite de peticiones (Rate Limit / Quota) de Gemini API. La plataforma ha intentado recuperar la llamada automáticamente. Por favor, aguarda 30-60 segundos y vuelve a pulsar el botón de análisis.";
      }

      res.status(500).json({ error: userErrMsg });
    }
  });

  // Dedicated endpoint for generating 100% full, unabridged, comprehensive translations
  app.post("/api/full-translation", async (req, res) => {
    try {
      const { analysisId, rawText, url, title, originalLanguage } = req.body;
      let targetText = rawText || "";
      let itemTitle = title || "";
      let sourceLang = originalLanguage || "idioma original";

      let targetAnalysis: AnalysisResult | undefined;
      if (analysisId && db[analysisId]) {
        targetAnalysis = db[analysisId];
        if (!targetText && targetAnalysis.originalExtractedText) {
          targetText = targetAnalysis.originalExtractedText;
        }
        if (!itemTitle) itemTitle = targetAnalysis.title;
        if (!sourceLang) sourceLang = targetAnalysis.originalLanguage;
      }

      if (!targetText && url) {
        try {
          const response = await safeFetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
          });
          if (response.ok) {
            const html = await response.text();
            const $ = cheerio.load(html);
            $("script, style, header, footer, nav, iframe, noscript, svg, .subscription-widget-wrap, .comments-section").remove();
            targetText = $("article").text().trim() || $("main").text().trim() || $("body").text().trim();
            targetText = targetText.substring(0, 50000);
          }
        } catch (e) {
          console.warn("Could not fetch URL for full translation:", e);
        }
      }

      if (!targetText || targetText.trim().length < 10) {
        if (targetAnalysis) {
          targetText = `Título: ${targetAnalysis.title}\n\nResumen: ${targetAnalysis.executiveSummary}\n\nPuntos Clave:\n${targetAnalysis.keyPoints.join("\n")}\n\nDebates:\n${targetAnalysis.academicDebates || ""}`;
        } else {
          return res.status(400).json({ error: "No se proporcionó suficiente texto original para traducir íntegramente." });
        }
      }

      const systemInstruction = `Eres un traductor profesional, ensayista y catedrático universitario de máximo nivel. Tu única misión es generar una TRADUCCIÓN Y TRANSCRIPCIÓN ÍNTEGRA, COMPLETA, EXHAUSTIVA Y ESTRUCTURADA AL ESPAÑOL (CASTELLANO) de todo el contenido proporcionado.
REGLAS OBLIGATORIAS:
1. TRADUCCIÓN 100% COMPLETA: Traduce párrafo por párrafo, sección por sección, instrucción por instrucción, sin omitir ningún párrafo ni resumir ni condensar.
2. ESTRUCTURA IMPECABLE: Emplea formato Markdown elegante con subtítulos (##), párrafos bien separados, citas directas (>), listas y énfasis (negrita).
3. PRECISIÓN TÉCNICA Y LINGÜÍSTICA: Conserva todos los nombres propios, cifras, fechas, terminología técnica y matices del autor original.
4. PROHIBICIÓN DE ELIPSIS: Queda terminantemente prohibido truncar o colocar notas como "[continúa...]" o "[resumen del resto]". Traduce TODO el texto de principio a fin.`;

      const prompt = `Por favor, genera la traducción y transcripción exhaustiva e íntegra al castellano de este material:

Título del recurso: "${itemTitle}"
Idioma original: ${sourceLang}

Texto original completo a traducir íntegramente:
${targetText.substring(0, 45000)}`;

      const fullTranslation = await generateTextWithFallback(prompt, systemInstruction);
      if (!fullTranslation) {
        throw new Error("No se pudo generar la traducción completa.");
      }

      if (targetAnalysis) {
        targetAnalysis.translation = fullTranslation;
        targetAnalysis.isSpanishOrGalician = false; // ensure visible
        saveDatabase(db);
      }

      res.json({ fullTranslation, analysisId });
    } catch (err: any) {
      console.error("Error in /api/full-translation:", err);
      res.status(500).json({ error: err.message || "Error al generar la traducción íntegra." });
    }
  });

  // Automated Fact-Checking & Live Web Grounded Consultation ("la app misma que lo consulte")
  app.post("/api/analyses/:id/auto-factcheck", async (req, res) => {
    try {
      const { id } = req.params;
      const analysis = db[id];
      if (!analysis) {
        return res.status(404).json({ error: "Análisis no encontrado en la base de datos." });
      }

      const outputLang = analysis.outputLanguage || detectLanguage(`${analysis.title} ${analysis.executiveSummary}`);
      console.log(`[Audit v2] Auditoría por afirmaciones de "${analysis.title}" (idioma: ${outputLang})...`);

      // Estabilidad: mismo texto auditado → mismas afirmaciones (solo se repite la comprobación de la evidencia)
      const hasOriginalText = !!analysis.originalExtractedText && analysis.originalExtractedText.trim().length >= 200;
      const auditHash = analysis.frozen?.contentHash || contentHash(hasOriginalText ? analysis.originalExtractedText! : analysis.executiveSummary);
      const prevAudit = analysis.factCheckAudit;
      const reuseClaims =
        req.body?.freshClaims !== true &&
        prevAudit?.method === "claim_level_v2" &&
        prevAudit.textHash === auditHash &&
        Array.isArray(prevAudit.claimChecks) &&
        prevAudit.claimChecks.length > 0 &&
        prevAudit.claimChecks.every((c) => typeof c.neutralQuestion === "string");

      const deps: AuditDeps = {
        llmJson: (prompt, system, schema) => generateAnalysisContentWithRetry(prompt, system, schema, false, seedFromHash(auditHash)),
        groundedSearch: (prompt) => generateGroundedSearchText(prompt, undefined, { strict: true }),
      };

      const outcome = await runClaimAudit(deps, {
        title: analysis.title,
        lang: outputLang,
        sourceText: analysis.originalExtractedText,
        summary: analysis.executiveSummary,
        keyPoints: analysis.keyPoints,
      }, reuseClaims && prevAudit
        ? {
            frozenClaims: prevAudit.claimChecks!.map((c) => ({ claim: c.claim, quote: c.quote, claimType: c.claimType, neutralQuestion: c.neutralQuestion!, importance: c.importance ?? 3 })),
            frozenExtracted: prevAudit.coverage?.extracted,
          }
        : {});

      // Solo se reescribe el resumen con correcciones fuertes (contradichas, confianza >= 0.7, con fuente real).
      // El texto previo se conserva para poder revertir.
      let applied: string[] = [];
      let previousExecutiveSummary = analysis.factCheckAudit?.previousExecutiveSummary;
      let previousKeyPoints = analysis.factCheckAudit?.previousKeyPoints;
      if (outcome.strongCorrections.length > 0) {
        const rewritten = await rewriteWithCorrections(deps, {
          summary: analysis.executiveSummary,
          keyPoints: analysis.keyPoints,
          corrections: outcome.strongCorrections,
          lang: outputLang,
        });
        if (rewritten) {
          previousExecutiveSummary = previousExecutiveSummary ?? analysis.executiveSummary;
          previousKeyPoints = previousKeyPoints ?? analysis.keyPoints;
          analysis.executiveSummary = rewritten.executiveSummary;
          analysis.keyPoints = rewritten.keyPoints;
          applied = outcome.strongCorrections;
        }
      }

      analysis.factCheckAudit = {
        auditedAt: new Date().toISOString(),
        status: outcome.status,
        verdictTitle: outcome.verdictTitle,
        summaryAudit: outcome.summaryAudit,
        detectedErrors: [],
        correctionsApplied: applied,
        verifiedSources: outcome.verifiedSources,
        method: "claim_level_v2",
        auditedFrom: outcome.auditedFrom,
        claimChecks: outcome.claimChecks,
        counts: outcome.counts,
        coverage: outcome.coverage,
        textHash: auditHash,
        previousExecutiveSummary,
        previousKeyPoints,
      };

      saveDatabase(db);
      res.json(analysis);
    } catch (err: any) {
      console.error("Error en /api/analyses/:id/auto-factcheck:", err);
      res.status(500).json({ error: err.message || "Error al realizar la verificación automática con la web." });
    }
  });

  // User Interactive Correction Endpoint ("cuando hago una consulta y la salida no parece exacta que se pueda corregir")
  app.post("/api/analyses/:id/correct", async (req, res) => {
    try {
      const { id } = req.params;
      const { userCorrection, checkWithWeb, targetLanguage } = req.body;
      const analysis = db[id];
      if (!analysis) {
        return res.status(404).json({ error: "Análisis no encontrado en la base de datos." });
      }

      if (!userCorrection || userCorrection.trim().length < 2) {
        return res.status(400).json({ error: "Debe indicar la corrección u observación a aplicar." });
      }

      const outputLang = targetLanguage || (detectLanguage(userCorrection) === "galego" ? "galego" : analysis.outputLanguage || "castellano");
      const isGal = outputLang === "galego";
      const isCat = outputLang === "català";

      console.log(`[User Correction] Applying correction to analysis "${analysis.title}" (language: ${outputLang}, webCheck: ${checkWithWeb !== false})...`);

      let groundedInfo = "";
      let sources: Array<{ title: string; url: string }> = [];

      if (checkWithWeb !== false) {
        const searchPrompt = `Verifica con fuentes oficiales la siguiente corrección y datos aportados por el usuario para el tema "${analysis.title}":
Corrección del usuario: "${userCorrection}"
Obtén todas las cifras exactas (escaños, votos, porcentajes, fechas históricas, nombres de candidatos oficiales) para contrastar e incorporar en el informe.`;
        const searchRes = await generateGroundedSearchText(searchPrompt);
        groundedInfo = searchRes.text;
        sources = searchRes.sources;
      }

      const correctionSystemInstruction = `Eres un editor académico y de verificación de contenidos.
El usuario ha señalado una corrección o dato inexacto en el informe. Tu tarea es integrar fielmente la corrección del usuario, complementarla con los datos fácticos verificados y rectificar el informe.

${isGal ? `
*** OBRIGATORIO: LINGUA GALEGA ***
Redacta o informe rectificado, o resumo executivo, os puntos clave e as explicacións estritamente en LINGUA GALEGA formal e impecable!
` : isCat ? `
*** OBLIGATORI: CATALÀ ***
Redacta absolutament tot el text rectificat en català normatiu i formal.
` : `
Redacta el informe rectificado en español (castellano) universitario.
`}
`;

      const correctionPrompt = `
Título del análisis: "${analysis.title}"
Idioma de salida: ${outputLang}
Resumen actual:
${analysis.executiveSummary}

Puntos clave actuales:
${analysis.keyPoints.join("\n")}

Observación/Corrección del usuario:
"${userCorrection}"

${groundedInfo ? `Información de contraste obtenida de la web:\n${groundedInfo}` : ""}

Genera la versión corregida y el resumen de cambios aplicados.
`;

      const schema = {
        type: Type.OBJECT,
        properties: {
          summaryAudit: { type: Type.STRING, description: "Resumen de cómo se incorporó la corrección y qué datos fueron rectificados (en el idioma del informe)." },
          correctionsApplied: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Lista de correcciones aplicadas."
          },
          correctedExecutiveSummary: { type: Type.STRING, description: "Resumen ejecutivo rectificado con los datos precisos (en el idioma del informe)." },
          correctedKeyPoints: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Puntos clave rectificados (5 a 8 puntos en el idioma del informe)."
          },
          correctedNumericalExamples: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                concept: { type: Type.STRING },
                figureOrCost: { type: Type.STRING },
                explanation: { type: Type.STRING }
              },
              required: ["concept", "figureOrCost", "explanation"]
            }
          }
        },
        required: ["summaryAudit", "correctionsApplied", "correctedExecutiveSummary", "correctedKeyPoints"]
      };

      const rawResponse = await generateAnalysisContentWithRetry(
        correctionPrompt,
        correctionSystemInstruction,
        schema,
        false
      );

      const parsed = cleanJsonParse(rawResponse);

      analysis.outputLanguage = outputLang;
      analysis.executiveSummary = parsed.correctedExecutiveSummary || analysis.executiveSummary;
      analysis.keyPoints = parsed.correctedKeyPoints || analysis.keyPoints;
      if (parsed.correctedNumericalExamples && parsed.correctedNumericalExamples.length > 0) {
        analysis.numericalExamples = parsed.correctedNumericalExamples;
      }

      analysis.factCheckAudit = {
        auditedAt: new Date().toISOString(),
        status: "corrected",
        summaryAudit: parsed.summaryAudit,
        detectedErrors: [userCorrection],
        correctionsApplied: parsed.correctionsApplied || [userCorrection],
        verifiedSources: sources.length > 0 ? sources : [
          { title: "Verificación de Usuario y Contraste de Datos Oficiales", url: "https://infoelectoral.interior.gob.es/" }
        ],
        userFeedback: userCorrection
      };

      saveDatabase(db);
      res.json(analysis);
    } catch (err: any) {
      console.error("Error en /api/analyses/:id/correct:", err);
      res.status(500).json({ error: err.message || "Error al procesar la corrección." });
    }
  });

  // Direct manual save endpoint for editable sections
  // Rehidrata un análisis que el navegador conserva pero el servidor ha perdido (disco efímero de Render).
  // Nunca sobrescribe uno existente. Solo restaura objetos con la forma de AnalysisResult.
  app.post("/api/analyses/:id/restore", (req, res) => {
    const { id } = req.params;
    if (db[id]) return res.json(db[id]);
    if (Object.keys(db).length >= (Number(process.env.MAX_STORED_ANALYSES) || 500)) {
      return res.status(507).json({ error: "Almacén lleno: borra análisis antiguos antes de restaurar más." });
    }
    const a = req.body;
    const valid =
      a && typeof a === "object" && a.id === id &&
      typeof a.url === "string" && typeof a.title === "string" && typeof a.executiveSummary === "string" &&
      typeof a.analyzedAt === "string" && Array.isArray(a.keyPoints) && Array.isArray(a.categories) &&
      Array.isArray(a.bibliographicSources);
    if (!valid) return res.status(400).json({ error: "Análisis no válido para restaurar." });
    db[id] = a as AnalysisResult;
    saveDatabase(db);
    res.json(db[id]);
  });

  app.put("/api/analyses/:id", (req, res) => {
    const { id } = req.params;
    const analysis = db[id];
    if (!analysis) {
      return res.status(404).json({ error: "Análisis no encontrado en la base de datos." });
    }

    const { title, executiveSummary, keyPoints, numericalExamples, categories, outputLanguage } = req.body;
    if (title) analysis.title = title;
    if (executiveSummary) analysis.executiveSummary = executiveSummary;
    if (Array.isArray(keyPoints)) analysis.keyPoints = keyPoints;
    if (Array.isArray(numericalExamples)) analysis.numericalExamples = numericalExamples;
    if (Array.isArray(categories)) analysis.categories = categories;
    if (outputLanguage) analysis.outputLanguage = outputLanguage;
    analysis.isEditedManually = true;

    saveDatabase(db);
    res.json(analysis);
  });

  // Language switcher endpoint ("traducir o cambiar idioma del análisis a Galego/Castellano/etc.")
  app.post("/api/analyses/:id/switch-language", async (req, res) => {
    try {
      const { id } = req.params;
      const { targetLanguage } = req.body;
      const analysis = db[id];
      if (!analysis) {
        return res.status(404).json({ error: "Análisis no encontrado." });
      }

      const validLang = targetLanguage === "galego" ? "galego" : (targetLanguage === "català" ? "català" : (targetLanguage === "english" ? "english" : "castellano"));
      const langName = validLang === "galego" ? "Gallego (Galego)" : (validLang === "català" ? "Catalán (Català)" : (validLang === "english" ? "English" : "Español (Castellano)"));

      console.log(`[Switch Language] Converting analysis "${analysis.title}" to ${langName}...`);

      const systemInstruction = `Eres un traductor académico y catedrático universitario de alto nivel.
Tu tarea es traducir y adaptar fielmente TODO el análisis proporcionado al idioma ${langName}.
Conserva rigurosamente todas las cifras, fechas, datos electorales, nombres de personas, conceptos y estructura universitaria.`;

      const prompt = `Traduce y adapta íntegramente la siguiente estructura analítica al idioma ${langName}:

Título: "${analysis.title}"
Categorías: ${analysis.categories.join(", ")}
Resumen Ejecutivo:
${analysis.executiveSummary}

Puntos Clave:
${analysis.keyPoints.join("\n")}

${analysis.academicDebates ? `Debates Académicos:\n${analysis.academicDebates}` : ""}
`;

      const schema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          categories: { type: Type.ARRAY, items: { type: Type.STRING } },
          executiveSummary: { type: Type.STRING },
          keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          academicDebates: { type: Type.STRING }
        },
        required: ["title", "categories", "executiveSummary", "keyPoints"]
      };

      const rawResult = await generateAnalysisContentWithRetry(prompt, systemInstruction, schema, false);
      const parsed = cleanJsonParse(rawResult);

      analysis.title = parsed.title || analysis.title;
      analysis.categories = parsed.categories || analysis.categories;
      analysis.executiveSummary = parsed.executiveSummary || analysis.executiveSummary;
      analysis.keyPoints = parsed.keyPoints || analysis.keyPoints;
      if (parsed.academicDebates) analysis.academicDebates = parsed.academicDebates;
      analysis.outputLanguage = validLang;

      saveDatabase(db);
      res.json(analysis);
    } catch (err: any) {
      console.error("Error al cambiar idioma:", err);
      res.status(500).json({ error: err.message || "Error al traducir el análisis." });
    }
  });

  // Manejador central de errores (HttpError, URL no segura, cuerpo demasiado grande, JSON mal formado)
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof UnsafeUrlError) return res.status(400).json({ error: err.message });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: `Cuerpo demasiado grande (máx. ${MAX_BODY_MB} MB).` });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON mal formado." });
    console.error("Error no controlado:", err);
    res.status(500).json({ error: "Error interno del servidor." });
  });

  // Serve frontend assets
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Lupa Crítica server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
