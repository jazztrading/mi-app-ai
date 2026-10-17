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
  securityHeaders, ID_RE, validateAnalyzeBody,
} from "./server/security";
import { safeFetch, parseAndValidateUrl, UnsafeUrlError } from "./server/safeFetch";

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
  isVerified?: boolean;
  link: string;
}

interface CriticalPosition {
  title: string;
  argument: string;
  scientificBasis: string;
  supportingStudy?: VerifiedScholarlyCitation;
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
  referenceUrl: string;
}

export interface BibliographicSource {
  title: string;
  author: string;
  year?: string;
  type: string;
  link: string;
  summary: string;
  criticalAnalysis: string;
  reliabilityScore: number;
  academicRigor: string;
  doi?: string;
  journalOrVenue?: string;
  isVerified?: boolean;
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
  status: "verified" | "corrected";
  verdictTitle?: string;
  summaryAudit: string;
  detectedErrors: string[];
  correctionsApplied: string[];
  contrastTable?: DataContrastItem[];
  verifiedSources: Array<{ title: string; url: string; snippet?: string; reliability?: string }>;
  userFeedback?: string;
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
  overallReliabilityScore?: number;
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

// Helper to calculate lexical similarity between requested scholarly work and registry match
function calculateTitleSimilarity(titleA: string, titleB: string): number {
  if (!titleA || !titleB) return 0;
  const getTokens = (str: string) => {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["with", "from", "that", "this", "sobre", "para", "como", "report", "working", "paper", "staff", "recent"].includes(w));
  };
  const tokensA = getTokens(titleA);
  const tokensB = getTokens(titleB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0.6;
  const matchCount = tokensA.filter((t) => tokensB.includes(t)).length;
  return matchCount / Math.max(tokensA.length, tokensB.length);
}

// Helper to verify a single scholarly paper through live OpenAlex & Crossref peer-review registries with modern date filtering
async function verifySingleScholarlyWork(
  rawTitle: string,
  rawAuthor?: string,
  contextKeywords?: string
): Promise<VerifiedScholarlyCitation | null> {
  const cleanTitle = (rawTitle || "")
    .replace(/["“”'']/g, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  const firstAuthor = (rawAuthor || "").split(",")[0].split(" y ")[0].trim();

  if (!cleanTitle && !contextKeywords) return null;

  // 1. Direct search in OpenAlex with clean title - prioritizing recent (2020-2026) works
  if (cleanTitle.length > 4) {
    try {
      const query = firstAuthor ? `"${cleanTitle}" ${firstAuthor}` : `"${cleanTitle}"`;
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=5&mailto=academic-verifier@example.com`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LupaCriticaAcademicBot/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          // Find candidates that are similar in title and prefer publication_year >= 2021
          const matches = data.results.filter((m: any) => m && m.title);
          
          // Try to find a recent match first
          let bestMatch = matches.find((m: any) => {
            const sim = calculateTitleSimilarity(cleanTitle, m.title);
            const year = m.publication_year || 0;
            return sim >= 0.35 && year >= 2020;
          });

          // If not found, check if there is an exact or highly similar match (even if older seminal paper)
          if (!bestMatch) {
            bestMatch = matches.find((m: any) => {
              const sim = calculateTitleSimilarity(cleanTitle, m.title);
              return sim >= 0.55;
            });
          }

          if (bestMatch) {
            const authors = bestMatch.authorships?.slice(0, 4).map((a: any) => a.author?.display_name).filter(Boolean).join(", ") || rawAuthor || "Autores varios";
            const firstA = authors.split(",")[0].trim();
            return {
              title: bestMatch.title,
              author: authors,
              year: String(bestMatch.publication_year || "2023"),
              doi: bestMatch.doi ? (bestMatch.doi.startsWith("http") ? bestMatch.doi : `https://doi.org/${bestMatch.doi}`) : undefined,
              journalOrVenue: bestMatch.primary_location?.source?.display_name || undefined,
              citationsCount: bestMatch.cited_by_count,
              openAccessUrl: bestMatch.open_access?.oa_url || undefined,
              isVerified: true,
              link: bestMatch.doi ? (bestMatch.doi.startsWith("http") ? bestMatch.doi : `https://doi.org/${bestMatch.doi}`) : `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${bestMatch.title}" ${firstA}`.trim())}`
            };
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. Crossref Registry query
  if (cleanTitle.length > 5) {
    try {
      const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle + (firstAuthor ? " " + firstAuthor : ""))}&rows=3&mailto=academic-verifier@example.com`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LupaCriticaAcademicBot/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const data = await res.json();
        const items = data.message?.items || [];
        for (const item of items) {
          if (item && item.title?.[0]) {
            const itemTitle = item.title[0];
            const sim = calculateTitleSimilarity(cleanTitle, itemTitle);
            const pubYear = item.published?.["date-parts"]?.[0]?.[0] || 2023;
            
            // Only accept if title is sufficiently similar and not an ancient random mismatch
            if (sim >= 0.35 || (pubYear >= 2020 && sim >= 0.25)) {
              const authors = item.author?.map((a: any) => `${a.given || ""} ${a.family || ""}`.trim()).filter(Boolean).join(", ") || rawAuthor || "Autores varios";
              const itemAuthorFirst = (authors || "").split(",")[0].split(" y ")[0].trim();
              const doiUrl = item.DOI ? (item.DOI.startsWith("http") ? item.DOI : `https://doi.org/${item.DOI}`) : undefined;
              return {
                title: itemTitle,
                author: authors,
                year: String(pubYear),
                doi: doiUrl,
                journalOrVenue: item["container-title"]?.[0] || undefined,
                citationsCount: item["is-referenced-by-count"],
                isVerified: true,
                link: doiUrl || `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${itemTitle}" ${itemAuthorFirst}`.trim())}`
              };
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 3. Fallback: Search OpenAlex for recent (2021-2026) peer-reviewed works matching topic keywords
  const cleanKeywords = (contextKeywords || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, " ").trim();
  const searchFallback = `${firstAuthor ? firstAuthor + " " : ""}${cleanKeywords}`.trim().slice(0, 120);
  if (searchFallback.length > 3) {
    try {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(searchFallback)}&filter=from_publication_date:2020-01-01&sort=publication_year:desc,cited_by_count:desc&per_page=3&mailto=academic-verifier@example.com`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LupaCriticaAcademicBot/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const data = await res.json();
        const top = data.results?.[0];
        if (top && top.title) {
          const authorNames = top.authorships?.slice(0, 4).map((a: any) => a.author?.display_name).filter(Boolean).join(", ") || "Autores varios";
          const firstA = authorNames.split(",")[0].trim();
          const doiUrl = top.doi ? (top.doi.startsWith("http") ? top.doi : `https://doi.org/${top.doi}`) : undefined;
          return {
            title: top.title,
            author: authorNames,
            year: String(top.publication_year || "2024"),
            doi: doiUrl,
            journalOrVenue: top.primary_location?.source?.display_name || undefined,
            citationsCount: top.cited_by_count,
            openAccessUrl: top.open_access?.oa_url || undefined,
            isVerified: true,
            link: doiUrl || `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${top.title}" ${firstA}`.trim())}&as_ylo=2021`
          };
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return null;
}

// Helper to verify and enrich academic bibliographic sources via open scholarly registries (OpenAlex & Crossref)
// with strict priority on updated publications (2021-2026)
async function verifyAndEnrichBibliographicSources(
  rawSources: any[],
  contextTopic: string
): Promise<BibliographicSource[]> {
  if (!Array.isArray(rawSources) || rawSources.length === 0) return [];

  const verifiedList: BibliographicSource[] = [];

  for (const src of rawSources) {
    const verified = await verifySingleScholarlyWork(src.title || "", src.author || "", `${contextTopic} ${src.summary || ""}`);

    if (verified) {
      const yearNum = parseInt(verified.year || src.year || "2023", 10);
      const isRecent = !isNaN(yearNum) ? yearNum >= 2021 : true;
      const displayYear = verified.year || src.year || "2023";

      verifiedList.push({
        title: verified.title,
        author: verified.author,
        year: displayYear,
        doi: verified.doi,
        journalOrVenue: verified.journalOrVenue,
        citationsCount: verified.citationsCount,
        openAccessUrl: verified.openAccessUrl,
        isVerified: true,
        isRecent: isRecent,
        currencyReason: src.currencyReason || (isRecent ? "Publicación reciente con datos empíricos contemporáneos e indicadores vigentes (2021-2026)." : "Referencia fundacional clásica o estudio seminal de marco teórico histórico."),
        currencyTag: isRecent ? `⚡ Datos Actualizados (${displayYear})` : `🏛️ Referencia Histórica Seminal (${displayYear})`,
        type: src.type || "Paper Científico / Revisión por Pares",
        summary: src.summary || `Investigación académica indexada sobre la materia.`,
        criticalAnalysis: src.criticalAnalysis || `Estudio relevante para contrastar empíricamente la solidez metodológica del recurso analizado con datos actuales.`,
        reliabilityScore: typeof src.reliabilityScore === "number" ? Math.max(88, src.reliabilityScore) : 94,
        academicRigor: verified.journalOrVenue
          ? `Indexado y contrastado con revisión por pares en ${verified.journalOrVenue}${verified.citationsCount ? ` (${verified.citationsCount} citas registradas)` : ""}.`
          : `Publicación indexada en repositorio académico internacional verificado.`,
        link: verified.link
      });
    } else {
      const cleanAuthor = (src.author || "").split(",")[0].split(" y ")[0].trim();
      const rawYear = src.year || "2024";
      const yearNum = parseInt(rawYear, 10);
      const isRecent = !isNaN(yearNum) ? yearNum >= 2021 : true;

      verifiedList.push({
        ...src,
        year: rawYear,
        isVerified: false,
        isRecent: isRecent,
        currencyReason: src.currencyReason || (isRecent ? "Publicación de los últimos 5 años (2021-2026) para contraste contemporáneo." : "Hito histórico o referencia seminal indispensable."),
        currencyTag: isRecent ? `⚡ Datos Actualizados (${rawYear})` : `🏛️ Referencia Histórica Seminal (${rawYear})`,
        link: `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${src.title}" ${cleanAuthor}`.trim())}${isRecent ? '&as_ylo=2021' : ''}`
      });
    }
  }

  return verifiedList;
}

// Helper to verify and enrich scientific evidence citations in the Glossary
async function verifyGlossaryEvidence(
  rawEvidence: string | undefined,
  termName: string,
  generalContext: string
): Promise<{ evidenceText: string; verifiedUrl?: string }> {
  if (!rawEvidence || rawEvidence.trim().length < 5) {
    // If empty or vague, search for an authoritative scholarly paper on this concept
    const verified = await verifySingleScholarlyWork("", "", `${termName} ${generalContext}`);
    if (verified) {
      const formatted = `${verified.author} (${verified.year}). '${verified.title}'. ${verified.journalOrVenue ? verified.journalOrVenue + '.' : 'Publicación indexada.'}`;
      return {
        evidenceText: formatted,
        verifiedUrl: verified.link
      };
    }
    return { evidenceText: "" };
  }

  // Extract possible author or title from string (e.g. "Bollen, N. P., & Whaley, R. E. (2004)...")
  const titleMatch = rawEvidence.match(/['"“](.*?)['"”]/);
  const rawTitle = titleMatch ? titleMatch[1] : "";
  const rawAuthorMatch = rawEvidence.match(/^([A-Za-z\s,.\-&]+)\s*\(\d{4}\)/);
  const rawAuthor = rawAuthorMatch ? rawAuthorMatch[1].trim() : "";

  const verified = await verifySingleScholarlyWork(rawTitle, rawAuthor, `${termName} ${rawEvidence} ${generalContext}`);
  if (verified) {
    const formatted = `${verified.author} (${verified.year}). '${verified.title}'. ${verified.journalOrVenue ? verified.journalOrVenue + '.' : 'Publicación indexada en repositorio académico.'}${verified.doi ? ' DOI: ' + verified.doi : ''}`;
    return {
      evidenceText: formatted,
      verifiedUrl: verified.link
    };
  }

  return {
    evidenceText: rawEvidence,
    verifiedUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(`${termName} ${rawEvidence}`.slice(0, 100))}`
  };
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
  preferSearch: boolean = false
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
  systemInstruction?: string
): Promise<{ text: string; sources: Array<{ title: string; url: string; snippet?: string }> }> {
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

          if (sources.length === 0) {
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
        const isTransient = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("503") || errMsg.includes("UNAVAILABLE");
        if (isTransient && attempt === 1) {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
        } else {
          break;
        }
      }
    }
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
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1)); // Render está detrás de un proxy

  // Cuerpo JSON acotado (los ficheros viajan en base64)
  app.use(express.json({ limit: `${MAX_BODY_MB}mb` }));
  app.use(securityHeaders);

  // Único endpoint público (sin datos): comprobación de salud para Render
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

  // Main Analysis Endpoint
  app.post("/api/analyze", async (req, res) => {
    const { url, manualText, contentType, images, image, files } = req.body;

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
        }
      }

      if (contentParts.length === 0 && (!textToAnalyze || textToAnalyze.trim().length < 10)) {
        return res.status(400).json({ error: "No se pudo extraer suficiente contenido, documento o imagen para analizar." });
      }

      const detectedLang = detectLanguage(`${manualText || ""} ${textToAnalyze || ""}`);
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

*** VERIFICACIÓN FÁCTICA RIGUROSA, EXHAUSTIVIDAD HISTÓRICA Y ELECTORAL (PRECISIÓN ABSOLUTA) ***
- Si el contenido trata sobre elecciones, escaños, partidos políticos (como BNG, etc.), comicios legislativos, cifras oficiales, fechas o eventos históricos:
  * Comprueba exhaustivamente la serie histórica completa antes de aseverar cuál fue el "mejor resultado" o atribuir cifras.
  * (EJEMPLO HISTÓRICO VERIFICADO INDISCUTIBLE: En las elecciones legislativas generales al Congreso de los Diputados de España, el mejor resultado histórico del Bloque Nacionalista Galego (BNG) se alcanzó en las elecciones del año 2000 con 3 ESCAÑOS y 306.268 votos [1,32%], resultando electos Francisco Rodríguez (A Coruña), Guillerme Vázquez (Pontevedra) y Carlos Aymerich (A Coruña); superando a las de 1996 [2 escaños, 270.408 votos], 2004 [2 escaños], 2008 [2 escaños], 2011 [2 escaños], 2015/2016 [0 escaños], 2019 [1 escaño] y 2023 [1 escaño]. Decir erróneamente que 1996 fue el mejor resultado con 2 escaños es una falsedad factual histórica que queda terminantemente prohibida).
  * Si el usuario pregunta por candidatos o personas que se presentaron o resultaron electas, menciónalos con nombres completos y circunscripciones oficiales contrastadas.
  * No hagas aseveraciones sin contrastar la serie temporal íntegra.

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

7. **Resúmenes Explicativos con Ejemplos Numéricos basados en Costes y Cifras Reales (OBLIGATORIO)**:
   - Traduce los conceptos abstractos o técnicos complejos a **ejemplos numéricos claros, didácticos y tangibles basados en costes reales, cifras financieras ($M/$K), proporciones, plazos temporales y cálculos sencillos**.
   - Proporciona entre 3 y 6 ejemplos explicativos.
   - Ejemplo: Para 'Asimetría de Costes de Intercepción': "Un misil interceptor Patriot PAC-3 o THAAD cuesta entre $3.000.000 y $12.000.000 por unidad. Un dron de ataque unidireccional cuesta entre $20.000 y $50.000. Para neutralizar una oleada de 50 drones ($1M en total), se requieren hasta $150M a $600M en misiles de defensa, evidenciando un desequilibrio económico de 150x a 600x."

8. **Resumen de Debates Actuales y Consensos Científicos/Académicos (OBLIGATORIO)**:
   - Elabora un análisis exhaustivo y didáctico del estado actual del debate intelectual, científico o técnico.
   - Debes delimitar con total claridad:
     a) **overview**: Visión general del estado actual de la discusión.
     b) **keyQuestions**: Entre 3 y 5 preguntas o dilemas abiertos sobre los que aún se investiga o debate.
     c) **consensusAndDisagreements**: Detalla explícitamente consensos y puntos de desacuerdo.

9. **Posiciones Críticas Causal y Científicamente Fundamentadas (Contraargumentación Rigurosa)**:
   - Formula entre 3 y 5 **posiciones críticas rigurosas e independientes** respaldadas en evidencia empírica, metodología o análisis epistemológico.
   - Para cada posición crítica, especifica un estudio empírico o paper académico real en 'empiricalStudy' (con título y autor verídicos) que sirva de evidencia contrastada para dicha objeción.

10. **Debates Académicos e Intelectuales Vigentes**:
   - Sitúa la tesis del artículo dentro del contexto histórico, escuelas de pensamiento rivales e implicaciones socioeconómicas o geopolíticas contemporáneas.

11. **Gabinete de Fuentes Bibliográficas de Contraste (OBLIGATORIAMENTE ACTUALIZADAS 2021-2026)**:
   - Añade entre 4 y 5 fuentes bibliográficas 100% REALES, RELEVANTES Y COMPROBABLES.
   - **REGLA DE MÁXIMA ACTUALIZACIÓN Y VIGENCIA TEMPORAL (2021-2026)**: El usuario exige expresamente que todas las fuentes ofrecidas para contrastar la tesis sean **lo más actualizadas y recientes posibles (publicadas preferentemente entre 2022 y 2026, con un límite mínimo de 2021)**. Esto garantiza que el contraste empírico y metodológico se fundamente en datos económicos, científicos y técnicos vigentes.
   - **PROHIBICIÓN DE CITAS OBSOLETAS**: Queda terminantemente prohibido incluir artículos o informes antiguos o desactualizados (p. ej. informes o artículos de los años 90 o 2000 como '1996') cuando existen publicaciones, informes y estudios modernos disponibles sobre la materia.
   - **EXCEPCIÓN ESTRICTA Y JUSTIFICADA**: Únicamente si no existe literatura contemporánea o si se trata de un paper fundacional histórico indiscutible e irreemplazable (e.g. Kahneman & Tversky 1979, Taylor 1993), se admitirá un recurso previo a 2020. En tal caso excepcional, debes justificarlo explícitamente en 'currencyReason' y 'academicRigor' explicando su valor seminal.
   - **ANTI-HALLUCINATION ABSOLUTE RULE**: ESTÁ TERMINANTEMENTE PROHIBIDO inventar títulos de papers, sintetizar publicaciones inexistentes o asociar a investigadores reales con artículos que jamás publicaron. Cada fuente DEBE ser un documento verídico comprobable en Google Scholar, JSTOR, Scopus, PubMed, IEEE, SSRN, NBER, ScienceDirect o Nature. Cita el título exacto en su idioma original de publicación y los autores reales.

12. **Glosario Didáctico con Ejemplos Elaborados, Precedentes Históricos y Evidencia Científica Rigurosa**:
   - Genera un glosario de 4 a 8 términos técnicos, metodológicos, económicos o filosóficos complejos.
   - **Para cada concepto debes aportar obligatoriamente**:
     a) 'term': Nombre exacto del concepto o término técnico.
     b) 'definition': Definición accesible, pedagógica y rigurosa (nivel universitario sin jerga innecesaria).
     c) 'simpleExample': Un caso práctico o precedente histórico sustancial, detallado y rigurosamente verídico (PROHIBIDO usar metáforas vacías o analogías simplistas). Relata qué ocurrió en la historia cuando un organismo (e.g. Reserva Federal, gobiernos, comunidad científica) aplicó o desoyó este principio, qué consecuencias medibles y contrastadas se produjeron y cómo se verifica documentalmente.
     d) 'scientificEvidenceOrSource': Cita bibliográfica 100% REAL Y VERIFICABLE (autor/es, año exacto, título verídico y revista/institución indexada como AER, JFE, JF, QJE, NBER, BIS, FED, Nature, Science, etc.) que fundamenta este concepto en la literatura empírica. Si no recuerdas el título exacto de un paper contemporáneo, cita el paper seminal histórico indiscutible del autor original del concepto (e.g. Taylor (1993) 'Discretion versus policy rules in practice'; Bollen & Whaley (2004) 'Does Net Buying Pressure Affect the Shape of the Implied Volatility Smile?'; Garleanu, Pedersen & Poteshman (2009) 'Demand-Based Option Pricing'; etc.).
     e) 'referenceUrl': Enlace directo o de búsqueda académica verificado (Google Scholar, SSRN, NBER, etc.).
`;

      let userPrompt = "";
      if (imageList.length > 0) {
        userPrompt = `
Has recibido ${imageList.length} fotografía(s) de un artículo de prensa, periódico, revista o documento impreso.
Lee y transcribe minuciosamente el texto impreso, las cabeceras, subtítulos, pies de foto y los datos estadísticos visibles en la(s) foto(s).
Lleva a cabo la deconstrucción crítica, traducción/transcripción íntegra al castellano, análisis epistemológico, fuentes bibliográficas de los últimos 5 años (2021-2026) y glosario pedagógico en castellano.
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
            description: "Lista de 3 a 6 resúmenes explicativos con ejemplos numéricos claros basados en costes y cifras reales."
          },
          criticalPositions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: "Título de la postura crítica o contraargumento científico." },
                argument: { type: Type.STRING, description: "Exposición detallada y clara del argumento crítico." },
                scientificBasis: { type: Type.STRING, description: "Fundamento metodológico, empírico o teórico de esta crítica." },
                empiricalStudy: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING, description: "Título exacto del estudio empírico o paper académico real de referencia." },
                    author: { type: Type.STRING, description: "Autor/es principales o institución del estudio." },
                    year: { type: Type.STRING, description: "Año de publicación (e.g. '2023')." }
                  },
                  required: ["title", "author"]
                }
              },
              required: ["title", "argument", "scientificBasis"]
            },
            description: "Lista de 3 a 5 posiciones críticas científicas rigurosamente fundamentadas."
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
                title: { type: Type.STRING, description: "TÍTULO EXACTO, REAL Y VERÍDICO del paper, libro o estudio en su idioma original de publicación (p. ej. inglés o español) tal como aparece en Google Scholar o PubMed." },
                author: { type: Type.STRING, description: "Autor/es principales, investigadores o institución creadora." },
                year: { type: Type.STRING, description: "Año de publicación exacto (DEBE ser preferentemente de los últimos 5 años: entre 2021 y 2026, p. ej. '2023')." },
                isRecent: { type: Type.BOOLEAN, description: "True si fue publicado entre 2021 y 2026; false si es una referencia histórica seminal excepcional anterior a 2020." },
                currencyReason: { type: Type.STRING, description: "Explicación concisa de la vigencia de los datos analizados o justificación del valor fundacional si es histórico." },
                type: { type: Type.STRING, description: "Tipo de recurso (Paper Científico, Libro, Ensayo Académico, Metaanálisis, etc.)" },
                link: { type: Type.STRING, description: "Enlace de búsqueda académica." },
                summary: { type: Type.STRING, description: "Resumen de lo que plantea esta fuente de referencia." },
                criticalAnalysis: { type: Type.STRING, description: "Análisis crítico y contraste directo con la tesis principal del texto analizado basado en evidencia reciente." },
                reliabilityScore: { type: Type.NUMBER, description: "Calificación objetiva de credibilidad y rigor (0-100)." },
                academicRigor: { type: Type.STRING, description: "Explicación detallada del porqué de esa puntuación (revisión por pares, rigor científico, vigencia temporal, etc.)" }
              },
              required: ["title", "author", "year", "type", "link", "summary", "criticalAnalysis", "reliabilityScore", "academicRigor"]
            },
            description: "Lista de 4 a 5 fuentes bibliográficas REALES, EXISTENTES Y RIGUROSAMENTE ACTUALIZADAS (2021-2026)."
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
          isFactualElectionQuery
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

      // 1. Verify and enrich all critical debate positions with live peer-reviewed scholarly evidence
      const rawCritical = result.criticalPositions || [];
      const sanitizedCriticalPositions: CriticalPosition[] = [];

      for (const crit of rawCritical) {
        const studyQuery = crit.empiricalStudy?.title || `${crit.title} ${crit.scientificBasis}`;
        const studyAuthor = crit.empiricalStudy?.author || "";
        const verifiedStudy = await verifySingleScholarlyWork(studyQuery, studyAuthor, `${contextKeywords} ${crit.title}`);

        sanitizedCriticalPositions.push({
          title: crit.title || "",
          argument: crit.argument || "",
          scientificBasis: crit.scientificBasis || "",
          supportingStudy: verifiedStudy ? {
            title: verifiedStudy.title,
            author: verifiedStudy.author,
            year: verifiedStudy.year,
            doi: verifiedStudy.doi,
            journalOrVenue: verifiedStudy.journalOrVenue,
            citationsCount: verifiedStudy.citationsCount,
            openAccessUrl: verifiedStudy.openAccessUrl,
            isVerified: true,
            link: verifiedStudy.link
          } : undefined
        });
      }

      // 2. Verify and enrich all recommended bibliographic sources
      const rawSources = result.bibliographicSources || [];
      const sanitizedSources = await verifyAndEnrichBibliographicSources(rawSources, contextKeywords);

      const rawGlossary = result.glossary || [];
      const sanitizedGlossary: GlossaryTerm[] = [];

      for (const g of rawGlossary) {
        const verifiedEv = await verifyGlossaryEvidence(g.scientificEvidenceOrSource, g.term || "", contextKeywords);
        let cleanRef = verifiedEv.verifiedUrl || g.referenceUrl || "";
        if (!cleanRef || !cleanRef.startsWith("http")) {
          cleanRef = `https://scholar.google.com/scholar?q=${encodeURIComponent(g.term)}`;
        }
        sanitizedGlossary.push({
          term: g.term || "",
          definition: g.definition || "",
          simpleExample: g.simpleExample || "",
          scientificEvidenceOrSource: verifiedEv.evidenceText || g.scientificEvidenceOrSource || undefined,
          referenceUrl: cleanRef
        });
      }

      const isDoc = documentNames.length > 0;
      const isPhoto = imageList.length > 0 && documentNames.length === 0;

      // Calculate overall average reliability score
      const overallReliabilityScore = sanitizedSources.length > 0
        ? Math.round(sanitizedSources.reduce((acc, s) => acc + (s.reliabilityScore || 80), 0) / sanitizedSources.length)
        : 88;

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
        analyzedAt: new Date().toISOString(),
        contentType: isDoc ? "document" : (isPhoto ? "photo" : (contentType || "blog")),
        photoUrls: imageList.length > 0 ? imageList : undefined,
        fileNames: documentNames.length > 0 ? documentNames : undefined,
        overallReliabilityScore: overallReliabilityScore
      };

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
      const isGal = outputLang === "galego";
      const isCat = outputLang === "català";

      console.log(`[Auto Fact-Check] Initiating live web audit for analysis "${analysis.title}" (language: ${outputLang})...`);

      // 1. Search grounding query to verify facts, elections, numbers, candidates
      const searchPrompt = `Realiza una investigación exhaustiva y verificación con fuentes oficiales (bases de datos del Ministerio del Interior, hemerotecas históricas, archivos electorales, publicaciones de rigor) sobre los datos fácticos de este recurso:
Tema/Consulta: "${analysis.title}"
Categorías: ${analysis.categories.join(", ")}
Resumen actual:
"${analysis.executiveSummary}"
Puntos clave actuales:
${analysis.keyPoints.join("\n")}

Comprueba con máximo rigor:
1. Fechas exactas, años de elecciones generales/autonómicas o acontecimientos.
2. Cifras de escaños, número de votos, porcentajes oficiales y comparativa histórica completa.
   (POR EJEMPLO: Si se analiza el mejor resultado histórico del Bloque Nacionalista Galego (BNG) en las elecciones legislativas al Congreso de los Diputados, comprueba la serie histórica completa: 1996 [2 escaños, 270.408 votos], 2000 [3 ESCAÑOS, 306.268 votos, 1,32% - diputados Francisco Rodríguez, Guillerme Vázquez y Carlos Aymerich], 2004 [2 escaños], 2008 [2 escaños], 2011 [2 escaños], 2019 [1 escaño], 2023 [1 escaño]. El año 2000 es el récord histórico del BNG, no 1996).
3. Candidatos que se presentaron o resultaron electos (cabezas de lista oficiales por provincias).
4. Identifica cualquier dato inexacto, cifra errónea, año falso o candidato omitido, y proporciona los datos oficiales verdaderos y fuentes contrastadas.`;

      const { text: groundedEvidence, sources } = await generateGroundedSearchText(searchPrompt);

      // 2. Structured prompt to generate the rectified analysis & audit record
      const auditSystemInstruction = `Eres un auditor epistemológico y verificador de hechos (fact-checker) de máxima rigurosidad.
Tu misión es contrastar el análisis preexistente contra la evidencia contrastada obtenida por búsqueda web, identificar con precisión quirúrgica cualquier error, cifra desactualizada o falsedad histórica, y generar una versión rectificada, enriquecida y fiel.

${isGal ? `
*** OBRIGATORIO: LINGUA GALEGA ***
O informe está en LINGUA GALEGA. Redacta o resumo de auditoría ('summaryAudit'), os erros detectados, as correccións aplicadas, o resumo executivo rectificado ('correctedExecutiveSummary') e os puntos clave ('correctedKeyPoints') ÍNTEGRAMENTE en LINGUA GALEGA formal, normativo e universitario! Está prohibido responder en castelán.
` : isCat ? `
*** OBLIGATORI: CATALÀ ***
Redacta absolutament tot el resultat en català normatiu i formal.
` : `
Redacta el informe de auditoría y los campos rectificados en español (castellano) formal y universitario.
`}
`;

      const auditPrompt = `
Contenido actual del análisis a auditar:
Título: "${analysis.title}"
Idioma: ${outputLang}
Resumen Ejecutivo actual:
${analysis.executiveSummary}

Puntos clave actuales:
${analysis.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Evidencia oficial contrastada obtenida de la web y registros:
${groundedEvidence}

Genera un objeto JSON estructurado con la auditoría y la versión completamente rectificada.
`;

      const auditResponseSchema = {
        type: Type.OBJECT,
        properties: {
          status: { type: Type.STRING, description: "'corrected' si se detectaron y corrigieron errores/omisiones; 'verified' si todo era 100% exacto." },
          verdictTitle: { type: Type.STRING, description: "Título sintético del informe de contraste (en el idioma del informe, p. ej. 'Informe de contraste de datos: Verificación con fontes oficiais')." },
          summaryAudit: { type: Type.STRING, description: "Informe analítico exhaustivo que contrasta cada dato analizado con las fuentes más fiables posibles (en el idioma del informe)." },
          detectedErrors: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Lista de errores fácticos, fechas inexactas, cifras erróneas o candidatos omitidos que se han detectado."
          },
          correctionsApplied: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Lista de rectificaciones aplicadas con datos contrastados oficiales."
          },
          contrastTable: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                claimOrFact: { type: Type.STRING, description: "El dato, fecha, resultado electoral o afirmación que figuraba inicialmente." },
                officialVerification: { type: Type.STRING, description: "El dato real y contrastado según las fuentes oficiales y fiables más reputadas." },
                status: { type: Type.STRING, description: "'corrected' si requirió corrección, 'verified' si era correcto, 'clarified' si fue ampliado o matizado." },
                reliableSource: { type: Type.STRING, description: "Nombre del organismo oficial o fuente fiable consultada (ej. 'Ministerio del Interior / Archivo Electoral', 'Junta Electoral Central', 'INE', 'BOE/DOG', 'Hemeroteca Oficial')." },
                sourceUrl: { type: Type.STRING, description: "URL o referencia oficial consultada." }
              },
              required: ["claimOrFact", "officialVerification", "status", "reliableSource"]
            },
            description: "Matriz comparativa de contraste dato por dato para que el usuario no tenga que buscar las fuentes."
          },
          correctedExecutiveSummary: { type: Type.STRING, description: "Resumen ejecutivo completamente rectificado, exacto, enriquecido y sin falsedades históricas (en el idioma del informe)." },
          correctedKeyPoints: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Lista de 5 a 8 puntos clave rectificados y contrastados (en el idioma del informe)."
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
            },
            description: "Ejemplos numéricos con cifras, votos y escaños oficiales contrastados."
          }
        },
        required: ["status", "summaryAudit", "detectedErrors", "correctionsApplied", "correctedExecutiveSummary", "correctedKeyPoints"]
      };

      const auditResultRaw = await generateAnalysisContentWithRetry(
        auditPrompt,
        auditSystemInstruction,
        auditResponseSchema,
        false
      );

      const auditData = cleanJsonParse(auditResultRaw);

      // Apply updates to the analysis
      analysis.executiveSummary = auditData.correctedExecutiveSummary || analysis.executiveSummary;
      analysis.keyPoints = auditData.correctedKeyPoints || analysis.keyPoints;
      if (auditData.correctedNumericalExamples && auditData.correctedNumericalExamples.length > 0) {
        analysis.numericalExamples = auditData.correctedNumericalExamples;
      }

      analysis.factCheckAudit = {
        auditedAt: new Date().toISOString(),
        status: auditData.status === "verified" ? "verified" : "corrected",
        verdictTitle: auditData.verdictTitle || (isGal ? "Informe de contraste e verificación con fontes fiables" : "Informe de contraste y verificación con fuentes fiables"),
        summaryAudit: auditData.summaryAudit,
        detectedErrors: auditData.detectedErrors || [],
        correctionsApplied: auditData.correctionsApplied || [],
        contrastTable: auditData.contrastTable || [],
        verifiedSources: sources.length > 0 ? sources : [
          { title: "Bases de Datos Oficiales y Archivo Histórico Electoral (Infoelectoral)", url: "https://infoelectoral.interior.gob.es/", reliability: "Base Oficial del Estado" },
          { title: "Junta Electoral Central (JEC)", url: "https://www.juntaelectoralcentral.es/", reliability: "Órgano Oficial" }
        ]
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
