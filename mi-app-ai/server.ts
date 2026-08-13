import express from "express";
import path from "path";
import fs from "fs";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { createRequire } from "module";
import mammoth from "mammoth";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

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

interface CriticalPosition {
  title: string;
  argument: string;
  scientificBasis: string;
}

interface ConstructiveDebatesSummary {
  overview: string;
  keyQuestions: string[];
  consensusAndDisagreements?: string;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  referenceUrl: string;
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
  bibliographicSources: Array<{
    title: string;
    author: string;
    year?: string;
    type: string;
    link: string;
    summary: string;
    criticalAnalysis: string;
    reliabilityScore: number;
    academicRigor: string;
  }>;
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
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Análisis no encontrado" });
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
            const parsePdfFunc = typeof pdfParse === "function" ? pdfParse : (pdfParse && (pdfParse as any).default);
            if (parsePdfFunc) {
              const pdfData = await parsePdfFunc(buffer);
              if (pdfData && pdfData.text) {
                extractedDocsText += `\n\n--- INICIO DEL DOCUMENTO PDF: "${fileName}" ---\n${pdfData.text}\n--- FIN DEL DOCUMENTO PDF ---`;
              }
            }
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

          // Special handler for Substack URLs (e.g. https://elarjonauta.substack.com/p/la-ia-china-o-el-arte-de-no-ser-gobernados?r=5h3vek)
          if (url.includes("substack.com/p/")) {
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
1. **Fotografías y Recortes de Prensa / Periódicos (OCR y Deconstrucción)**:
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
     c) **consensusAndDisagreements**: Detalla explícitamente **en qué puntos existe CONSENSO AMPLIO** entre los expertos/comunidad académica y **en qué puntos persisten DESACUERDOS Y CONTROVERSIAS ABIERTAS**.

8. **Posiciones Críticas Causal y Científicamente Fundamentadas (Contraargumentación Rigurosa)**:
   - Formula entre 3 y 5 **posiciones críticas rigurosas e independientes** respaldadas en evidencia empírica, metodología o análisis epistemológico.
   - Cada posición debe tener title, argument y scientificBasis.

9. **Debates Académicos e Intelectuales Vigentes**:
   - Sitúa la tesis del artículo dentro del contexto histórico, escuelas de pensamiento rivales e implicaciones socioeconómicas o geopolíticas contemporáneas.

10. **Gabinete de Fuentes Bibliográficas e Investigación Secundaria (2021-2026)**:
   - Añade entre 4 y 5 fuentes bibliográficas REALES, RELEVANTES Y PUBLICADAS STRICTLY EN LOS ÚLTIMOS 5 AÑOS (2021-2026) con títulos reales y exactos en su idioma original.

11. **Glosario Didáctico de Conceptos Complejos**:
   - Genera un glosario de 4 a 8 términos técnicos explicados con tono claro para estudiantes universitarios sin asumirse formación previa.
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
                scientificBasis: { type: Type.STRING, description: "Fundamento metodológico, empírico o teórico de esta crítica." }
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
                referenceUrl: { type: Type.STRING, description: "URL de referencia confiable o búsqueda educativa (e.g. Google Scholar, Wikipedia, Stanford Encyclopedia)." }
              },
              required: ["term", "definition", "referenceUrl"]
            },
            description: "Glosario didáctico de 4 a 8 conceptos complejos explicados para nivel universitario con enlaces de referencia."
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
            responseSchema: responseSchemaConfig
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

      const rawSources = result.bibliographicSources || [];
      const sanitizedSources = rawSources.map((s: any) => {
        let cleanLink = s.link || "";
        const searchTitleAuthor = `${s.title} ${s.author}`.trim();
        if (!cleanLink || !cleanLink.startsWith("http") || cleanLink.includes("jstor.org/stable/")) {
          cleanLink = `https://scholar.google.com/scholar?q=${encodeURIComponent(searchTitleAuthor)}`;
        }
        return {
          ...s,
          year: s.year || "2023",
          link: cleanLink
        };
      });

      const rawGlossary = result.glossary || [];
      const sanitizedGlossary = rawGlossary.map((g: any) => {
        let cleanRef = g.referenceUrl || "";
        if (!cleanRef || !cleanRef.startsWith("http")) {
          cleanRef = `https://scholar.google.com/scholar?q=${encodeURIComponent(g.term)}`;
        }
        return {
          term: g.term || "",
          definition: g.definition || "",
          referenceUrl: cleanRef
        };
      });

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
        criticalPositions: result.criticalPositions || [],
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
