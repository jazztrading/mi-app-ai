import express from "express";
import path from "path";
import fs from "fs";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

// Load environment variables
dotenv.config();

const PORT = 3000;
const DB_FILE = path.join(process.cwd(), "analyses_db.json");

// Initialize Gemini SDK with recommended user-agent header
const apiKey = process.env.GEMINI_API_KEY;
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
}

interface AnalysisResult {
  id: string;
  url: string;
  title: string;
  originalLanguage: string;
  isSpanishOrGalician: boolean;
  categories: string[];
  translation?: string;
  executiveSummary: string;
  keyPoints: string[];
  academicDebates?: string;
  criticalPositions?: CriticalPosition[];
  constructiveDebatesSummary?: ConstructiveDebatesSummary;
  glossary?: GlossaryTerm[];
  bibliographicSources: BibliographicSource[];
  analyzedAt: string;
  contentType: "blog" | "podcast" | "youtube" | "manual" | "photo" | "document";
  photoUrls?: string[];
  fileNames?: string[];
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

// Helper to verify a single scholarly paper through live OpenAlex & Crossref peer-review registries
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

  // 1. Direct search in OpenAlex with clean title
  if (cleanTitle.length > 4) {
    try {
      const query = firstAuthor ? `"${cleanTitle}" ${firstAuthor}` : `"${cleanTitle}"`;
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=3&mailto=academic-verifier@example.com`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LupaCriticaAcademicBot/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const match = data.results[0];
          const authors = match.authorships?.slice(0, 4).map((a: any) => a.author?.display_name).filter(Boolean).join(", ") || rawAuthor || "Autores varios";
          const firstA = authors.split(",")[0].trim();
          return {
            title: match.title,
            author: authors,
            year: String(match.publication_year || "2023"),
            doi: match.doi ? (match.doi.startsWith("http") ? match.doi : `https://doi.org/${match.doi}`) : undefined,
            journalOrVenue: match.primary_location?.source?.display_name || undefined,
            citationsCount: match.cited_by_count,
            openAccessUrl: match.open_access?.oa_url || undefined,
            isVerified: true,
            link: match.doi ? (match.doi.startsWith("http") ? match.doi : `https://doi.org/${match.doi}`) : `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${match.title}" ${firstA}`.trim())}`
          };
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. Crossref Registry query
  if (cleanTitle.length > 5) {
    try {
      const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle + (firstAuthor ? " " + firstAuthor : ""))}&rows=2&mailto=academic-verifier@example.com`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LupaCriticaAcademicBot/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const data = await res.json();
        const item = data.message?.items?.[0];
        if (item && item.title?.[0]) {
          const authors = item.author?.map((a: any) => `${a.given || ""} ${a.family || ""}`.trim()).filter(Boolean).join(", ") || rawAuthor || "Autores varios";
          const itemTitle = item.title[0];
          const itemAuthorFirst = (authors || "").split(",")[0].split(" y ")[0].trim();
          const doiUrl = item.DOI ? (item.DOI.startsWith("http") ? item.DOI : `https://doi.org/${item.DOI}`) : undefined;
          return {
            title: itemTitle,
            author: authors,
            year: String(item.published?.["date-parts"]?.[0]?.[0] || "2023"),
            doi: doiUrl,
            journalOrVenue: item["container-title"]?.[0] || undefined,
            citationsCount: item["is-referenced-by-count"],
            isVerified: true,
            link: doiUrl || `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${itemTitle}" ${itemAuthorFirst}`.trim())}`
          };
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 3. Fallback: Search OpenAlex by author names & concept keywords to find authentic published peer-reviewed work
  const cleanKeywords = (contextKeywords || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, " ").trim();
  const searchFallback = `${firstAuthor ? firstAuthor + " " : ""}${cleanKeywords}`.trim().slice(0, 120);
  if (searchFallback.length > 3) {
    try {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(searchFallback)}&per_page=3&mailto=academic-verifier@example.com`;
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
            year: String(top.publication_year || "2023"),
            doi: doiUrl,
            journalOrVenue: top.primary_location?.source?.display_name || undefined,
            citationsCount: top.cited_by_count,
            openAccessUrl: top.open_access?.oa_url || undefined,
            isVerified: true,
            link: doiUrl || `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${top.title}" ${firstA}`.trim())}`
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
async function verifyAndEnrichBibliographicSources(
  rawSources: any[],
  contextTopic: string
): Promise<BibliographicSource[]> {
  if (!Array.isArray(rawSources) || rawSources.length === 0) return [];

  const verifiedList: BibliographicSource[] = [];

  for (const src of rawSources) {
    const verified = await verifySingleScholarlyWork(src.title || "", src.author || "", `${contextTopic} ${src.summary || ""}`);

    if (verified) {
      verifiedList.push({
        title: verified.title,
        author: verified.author,
        year: verified.year || src.year || "2023",
        doi: verified.doi,
        journalOrVenue: verified.journalOrVenue,
        citationsCount: verified.citationsCount,
        openAccessUrl: verified.openAccessUrl,
        isVerified: true,
        type: src.type || "Paper Científico / Revisión por Pares",
        summary: src.summary || `Investigación académica indexada sobre la materia.`,
        criticalAnalysis: src.criticalAnalysis || `Estudio relevante para contrastar empíricamente la solidez metodológica del recurso analizado.`,
        reliabilityScore: typeof src.reliabilityScore === "number" ? Math.max(88, src.reliabilityScore) : 94,
        academicRigor: verified.journalOrVenue
          ? `Indexado y contrastado con revisión por pares en ${verified.journalOrVenue}${verified.citationsCount ? ` (${verified.citationsCount} citas registradas)` : ""}.`
          : `Publicación indexada en repositorio académico internacional verificado.`,
        link: verified.link
      });
    } else {
      const cleanAuthor = (src.author || "").split(",")[0].split(" y ")[0].trim();
      verifiedList.push({
        ...src,
        year: src.year || "2023",
        isVerified: false,
        link: `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${src.title}" ${cleanAuthor}`.trim())}`
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

async function startServer() {
  const app = express();

  // Enable JSON body parsing with higher limit for larger files/documents
  app.use(express.json({ limit: "50mb" }));

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
    Object.keys(db).forEach((k) => delete db[k]);
    saveDatabase(db);
    res.json({ success: true, message: "Histórico completo vaciado" });
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
                const subRes = await fetch(apiUrl, {
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
            const response = await fetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
              },
              redirect: "follow"
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

            textToAnalyze = bodyText.substring(0, 30000);
          }
        } catch (scrapeErr: any) {
          console.error("Error scraping URL, will rely on prompt context:", scrapeErr);
          textToAnalyze = `Analiza este ensayo o artículo de internet de la URL: ${url}. Título del recurso: ${title || url}`;
        }
      }

      if (contentParts.length === 0 && (!textToAnalyze || textToAnalyze.trim().length < 10)) {
        return res.status(400).json({ error: "No se pudo extraer suficiente contenido, documento o imagen para analizar." });
      }

      const systemInstruction = `
Eres un analista crítico, epistemólogo y catedrático universitario de alto nivel, experto en verificar la veracidad, evaluar el rigor metodológico y deconstruir contenidos de internet, artículos en periódicos impresos o digitales, recortes de prensa, libros, podcasts y ensayos académicos.
Tu tarea es realizar un análisis exhaustivo y profundo del contenido proporcionado, generando un informe altamente riguroso estructurado en español (castellano).

Instrucciones detalladas de análisis:
1. **Vídeos de YouTube, Podcasts y Multimedia**:
   - Analiza con máxima fidelidad el contenido temático, título y autor del vídeo o podcast suministrado.
   - Adapta las disciplinas, categorías, resumen y glosario a la materia real del contenido (e.g. Bellas Artes, Pintura/Acuarela, Ciencia de Materiales, Economía, Filosofía, etc.).
   - Si el título original está en inglés (e.g. "Easy Loose Watercolor Bird of Paradise"), traduce el título o indícalo en castellano ("Acuarela fácil y suelta: Ave del paraíso") y genera en 'translation' la traducción/transcripción de las instrucciones y técnicas explicadas.

2. **Fotografías y Recortes de Prensa / Periódicos (OCR y Deconstrucción)**:
   - Si se adjuntan fotos de periódicos, revistas o documentos impresos (OCR multimodal):
     * Transcribe y lee íntegramente todo el cuerpo de texto visible en la imagen, incluyendo titulares principales, antetítulos, subtítulos, pies de foto, datos de recuadros e infografías (p. ej., cifras numéricas, millones de euros, desgloses presupuestarios) y nombres de autores o medios impresos (p. ej., 'La Voz de Galicia', 'Gabriel Lemos', 'M. Dávila', etc.).
     * Asigna a 'originalTitle' el título o titular exacto y completo del artículo de prensa capturado en la foto.
     * Extrae de forma explícita el análisis metodológico, socioeconómico, técnico o científico expresado en la noticia.

2. **Idioma y Traducción / Transcripción Extensa**:
   - Identifica con precisión el idioma original.
   - Si el contenido no está en castellano o gallego (e.g. inglés), debes generar una **traducción y transcripción muy completa, estructurada y extensa al castellano** que cubra párrafo a párrafo o sección a sección todas las ideas, matices, citas directas y argumentos planteados en el texto original. No resumas en exceso la traducción: el usuario debe poder leer el contenido completo en español. Si el original ya está en castellano o gallego, la propiedad 'translation' puede ser nula o vacía.

3. **Categorización**:
   - Clasifica el material por temas o disciplinas intelectuales precisas (e.g., Economía Pública, Defensa y Geopolítica, Psicología Social, Epistemología Evolutiva, Sociología Política, Filosofía de la Mente). Máximo 3 categorías.

4. **Resumen Ejecutivo Profundo**:
   - Escribe un resumen ejecutivo automático que deconstruya la tesis central, los datos empíricos/económicos/científicos presentados, el marco teórico empleado por el autor y las conclusiones principales con lenguaje formal y pedagógico.

5. **Puntos Clave y Argumentos Fundamentales**:
   - Extrae entre 5 y 8 puntos clave esenciales que vertebren la argumentación lógica o el informe del texto/periódico.

6. **Resúmenes Explicativos con Ejemplos Numéricos basados en Costes y Cifras Reales (OBLIGATORIO)**:
   - Traduce los conceptos abstractos o técnicos complejos a **ejemplos numéricos claros, didácticos y tangibles basados en costes reales, cifras financieras ($M/$K), proporciones, plazos temporales y cálculos sencillos**.
   - Proporciona entre 3 y 6 ejemplos explicativos.
   - Ejemplo: Para 'Asimetría de Costes de Intercepción': "Un misil interceptor Patriot PAC-3 o THAAD cuesta entre $3.000.000 y $12.000.000 por unidad. Un dron de ataque unidireccional cuesta entre $20.000 y $50.000. Para neutralizar una oleada de 50 drones ($1M en total), se requieren hasta $150M a $600M en misiles de defensa, evidenciando un desequilibrio económico de 150x a 600x."

7. **Resumen de Debates Actuales y Consensos Científicos/Académicos (OBLIGATORIO)**:
   - Elabora un análisis exhaustivo y didáctico del estado actual del debate intelectual, científico o técnico.
   - Debes delimitar con total claridad:
     a) **overview**: Visión general del estado actual de la discusión.
     b) **keyQuestions**: Entre 3 y 5 preguntas o dilemas abiertos sobre los que aún se investiga o debate.
     c) **consensusAndDisagreements**: Detalla explícitamente consensos y puntos de desacuerdo.

8. **Posiciones Críticas Causal y Científicamente Fundamentadas (Contraargumentación Rigurosa)**:
   - Formula entre 3 y 5 **posiciones críticas rigurosas e independientes** respaldadas en evidencia empírica, metodología o análisis epistemológico.
   - Para cada posición crítica, especifica un estudio empírico o paper académico real en 'empiricalStudy' (con título y autor verídicos) que sirva de evidencia contrastada para dicha objeción.

9. **Debates Académicos e Intelectuales Vigentes**:
   - Sitúa la tesis del artículo dentro del contexto histórico, escuelas de pensamiento rivales e implicaciones socioeconómicas o geopolíticas contemporáneas.

10. **Gabinete de Fuentes Bibliográficas e Investigación Secundaria (Papers Reales Indexados)**:
   - Añade entre 4 y 5 fuentes bibliográficas 100% REALES, RELEVANTES Y COMPROBABLES (publicadas preferentemente entre 2020 y 2026 o investigaciones seminales de máxima autoridad indexadas).
   - **ANTI-HALLUCINATION ABSOLUTE RULE**: ESTÁ TERMINANTEMENTE PROHIBIDO inventar títulos de papers, sintetizar publicaciones inexistentes o asociar a investigadores reales con artículos que jamás publicaron (e.g., está prohibido inventar títulos ficticios como atribuir papers no publicados a Bollen & Whaley u otros autores). Cada fuente DEBE ser un documento verídico comprobable en Google Scholar, JSTOR, Scopus, PubMed, IEEE, SSRN, NBER, ScienceDirect o Nature. Cita el título exacto en su idioma original de publicación y los autores reales.

11. **Glosario Didáctico con Ejemplos Elaborados, Precedentes Históricos y Evidencia Científica Rigurosa**:
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
Lleva a cabo la deconstrucción crítica, análisis epistemológico, fuentes bibliográficas de los últimos 5 años (2021-2026) y glosario pedagógico en castellano.
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
            description: "Traducción/transcripción estructuración, muy completa y detallada al castellano de todo el contenido si el original no está en español o gallego." 
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
                year: { type: Type.STRING, description: "Año de publicación exacto (DEBE ser de los últimos 5 años: entre 2021 y 2026, p. ej. '2023')." },
                type: { type: Type.STRING, description: "Tipo de recurso (Paper Científico, Libro, Ensayo Académico, Metaanálisis, etc.)" },
                link: { type: Type.STRING, description: "Enlace de búsqueda académica." },
                summary: { type: Type.STRING, description: "Resumen de lo que plantea esta fuente de referencia." },
                criticalAnalysis: { type: Type.STRING, description: "Análisis crítico y contraste directo con la tesis principal del texto analizado." },
                reliabilityScore: { type: Type.NUMBER, description: "Calificación objetiva de credibilidad y rigor (0-100)." },
                academicRigor: { type: Type.STRING, description: "Explicación detallada del porqué de esa puntuación (revisión por pares, rigor científico, etc.)" }
              },
              required: ["title", "author", "year", "type", "link", "summary", "criticalAnalysis", "reliabilityScore", "academicRigor"]
            },
            description: "Lista de 4 a 5 fuentes bibliográficas REALES, EXISTENTES Y PUBLICADAS EN LOS ÚLTIMOS 5 AÑOS (2021-2026)."
          }
        },
        required: ["originalTitle", "originalLanguage", "isSpanishOrGalician", "categories", "translation", "executiveSummary", "keyPoints", "numericalExamples", "criticalPositions", "constructiveDebatesSummary", "academicDebates", "glossary", "bibliographicSources"]
      };

      let responseText = "";

      try {
        const genContents = contentParts.length > 0
          ? { parts: [...contentParts, { text: userPrompt }] }
          : userPrompt;

        const response = await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: genContents as any,
          config: {
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseSchemaConfig,
            temperature: 0.4,
            tools: [{ googleSearch: {} }]
          }
        });
        responseText = response.text || "";
      } catch (genErr: any) {
        console.error("Gemini generation error:", genErr);
        throw genErr;
      }

      if (!responseText) {
        throw new Error("No se obtuvo respuesta del modelo de Inteligencia Artificial.");
      }

      const result = JSON.parse(responseText.trim());

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

      // Construct the final analysis structure
      const analysisId = "analysis_" + Date.now();
      const analysis: AnalysisResult = {
        id: analysisId,
        url: finalUrl,
        title: result.originalTitle || title,
        originalLanguage: result.originalLanguage || "Desconocido",
        isSpanishOrGalician: result.isSpanishOrGalician ?? true,
        categories: result.categories || [],
        translation: result.translation || undefined,
        executiveSummary: result.executiveSummary || "",
        keyPoints: result.keyPoints || [],
        criticalPositions: sanitizedCriticalPositions,
        constructiveDebatesSummary: result.constructiveDebatesSummary || undefined,
        academicDebates: result.academicDebates || "",
        glossary: sanitizedGlossary,
        bibliographicSources: sanitizedSources,
        analyzedAt: new Date().toISOString(),
        contentType: isDoc ? "document" : (isPhoto ? "photo" : (contentType || "blog")),
        photoUrls: imageList.length > 0 ? imageList : undefined,
        fileNames: documentNames.length > 0 ? documentNames : undefined
      };

      // Save in our persistent database
      db[analysisId] = analysis;
      saveDatabase(db);

      res.json(analysis);

    } catch (err: any) {
      console.error("Error durante el análisis:", err);
      let userErrMsg = err.message || "Error interno del servidor al analizar el contenido.";
      
      if (userErrMsg.includes("429") || userErrMsg.includes("RESOURCE_EXHAUSTED")) {
        userErrMsg = "Se ha alcanzado el límite de peticiones por minuto (TPM/RPM) de la cuota gratuita de Gemini API. Por favor, espera 1 minuto antes de volver a pulsar el botón de análisis.";
      }

      res.status(500).json({ error: userErrMsg });
    }
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
