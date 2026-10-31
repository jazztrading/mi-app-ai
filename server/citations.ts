// Fase 1 · Integridad de citas.
//
// Tres niveles, siempre separados (principio 1):
//   1. EXISTE      → el registro (Crossref/OpenAlex) devuelve la obra.
//   2. COINCIDE    → título, primer apellido y año de la cita se corresponden con el registro.
//   3. RESPALDA    → el resumen de la obra apoya la afirmación a la que se asocia (con una frase literal como prueba).
// Solo una cita que cumple los tres se muestra como evidencia. La que solo cumple 1 y 2 se muestra como
// "existe y coincide, respaldo no comprobado". Una búsqueda por tema NUNCA se atribuye a la afirmación del modelo.
import { Type } from "@google/genai";

export type VerificationStatus = "exact" | "probable" | "related_unverified" | "not_found";
export type SupportVerdict = "supports" | "contradicts" | "mixed" | "unrelated" | "unassessed";

export interface RegistryRecord {
  doi?: string; // sin prefijo
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  type?: string;
  citedBy?: number;
  isRetracted?: boolean;
  hasConcern?: boolean;
  abstract?: string;
  openAccessUrl?: string;
  sourceUrl?: string; // página institucional donde se localizó (cuando no hay DOI)
  institutional?: boolean; // dominio de un organismo oficial reconocido (lista interna, no exhaustiva)
}

export interface CitationClaim {
  title: string;
  author?: string;
  year?: string | number;
  doi?: string;
  url?: string; // para informes institucionales sin DOI: se COMPRUEBA que la página contiene el título citado
}

export type PageFetcher = (url: string) => Promise<{ ok: boolean; html: string; finalUrl: string } | null>;

export interface VerificationResult {
  status: VerificationStatus;
  record?: RegistryRecord;
  titleSimilarity?: number;
  surname?: "first" | "any" | "none";
  yearDelta?: number;
  notes: string[];
}

// ── texto y similitud ────────────────────────────────────────────────────────
const NAME_STOP = new Set(["de", "del", "la", "las", "los", "el", "van", "von", "der", "den", "da", "do", "dos", "das", "di", "le", "and", "et", "al", "jr", "sr"]);

export function normalizeText(s: string): string {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Coeficiente de Dice sobre bigramas de caracteres del título normalizado (0-1). */
export function titleSimilarity(a: string, b: string): number {
  const A = normalizeText(a);
  const B = normalizeText(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = A.length - 1 + (B.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

/** Primer autor de una cadena tipo "Apellido, Nombre; Otro" o "Nombre Apellido y Otro". */
function firstAuthorChunk(raw?: string): string {
  const first = (raw || "").split(/;|&|\band\b|\by\b|\bet al\b/i)[0] || "";
  return first.split(",")[0].trim();
}
const nameTokens = (s: string) => normalizeText(s).split(" ").filter((t) => t.length >= 3 && !NAME_STOP.has(t));

export function surnameMatch(claimAuthor: string | undefined, recordAuthors: string[]): "first" | "any" | "none" {
  const ct = nameTokens(firstAuthorChunk(claimAuthor));
  if (!ct.length || !recordAuthors.length) return "none";
  const hit = (name: string) => {
    const rt = new Set(nameTokens(name));
    return ct.some((t) => rt.has(t));
  };
  if (hit(recordAuthors[0])) return "first";
  if (recordAuthors.slice(1, 12).some(hit)) return "any";
  return "none";
}

export function cleanDoi(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

export function reconstructAbstract(inverted: any): string | undefined {
  if (!inverted || typeof inverted !== "object") return undefined;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 5000) words[p as number] = w;
  }
  const text = words.filter((w) => w !== undefined).join(" ").trim();
  return text.length >= 40 ? text : undefined;
}

const stripJats = (s?: string) => (s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined);

/** true solo si `fragment` aparece de verdad en `text` (ignora mayúsculas, acentos y puntuación). */
export function locateFragment(fragment: string, text: string): boolean {
  const f = normalizeText(fragment);
  return f.length >= 12 && normalizeText(text).includes(f);
}

// ── literatura gris e informes institucionales ───────────────────────────────
// Los informes de organismos (Comisión Europea, OCDE, FMI, bancos centrales, institutos de estadística...) suelen no estar
// en Crossref ni OpenAlex. Se aceptan si la página indicada contiene realmente el título citado. Nunca llegan a "exact".
const INSTITUTIONAL_SUFFIXES = [
  "europa.eu", "oecd.org", "oecd-ilibrary.org", "imf.org", "worldbank.org", "un.org", "who.int", "ilo.org", "bis.org", "ecb.europa.eu",
  "bde.es", "airef.es", "ine.es", "seg-social.es", "boe.es", "congreso.es", "senado.es", "bancaditalia.it", "bundesbank.de", "banque-france.fr",
];
const INSTITUTIONAL_PATTERNS = [/\.gob\.es$/, /\.gov$/, /\.gov\.[a-z]{2}$/, /\.gouv\.fr$/, /\.europa\.eu$/];

export function isInstitutionalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return INSTITUTIONAL_SUFFIXES.some((x) => h === x || h.endsWith("." + x)) || INSTITUTIONAL_PATTERNS.some((re) => re.test(h));
}

const decodeEntities = (t: string) =>
  t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export function parseHtmlMeta(html: string): { titles: string[]; description?: string } {
  const titles: string[] = [];
  const grab = (re: RegExp) => {
    const m = html.match(re);
    if (m && m[1]) titles.push(decodeEntities(m[1].replace(/<[^>]+>/g, " ")));
  };
  grab(/<title[^>]*>([\s\S]*?)<\/title>/i);
  grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  grab(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  grab(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const d =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const description = d ? decodeEntities(d[1]) : undefined;
  return { titles: titles.filter(Boolean), description: description && description.length >= 40 ? description : undefined };
}

/** Similitud para títulos de página: además de Dice, acepta que un título contenga al otro (p. ej. "... - European Commission"). */
function pageTitleSimilarity(claimTitle: string, pageTitle: string): number {
  const a = normalizeText(claimTitle).replace(/^the /, "");
  const b = normalizeText(pageTitle).replace(/^the /, "");
  const dice = titleSimilarity(a, b);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const contains = shorter.split(" ").length >= 4 && longer.includes(shorter);
  return Math.max(dice, contains ? 0.95 : 0);
}

export async function verifyInstitutionalPage(claim: CitationClaim, fetchPage: PageFetcher): Promise<VerificationResult> {
  if (!claim.url) return { status: "not_found", notes: [] };
  let host = "";
  try {
    const u = new URL(claim.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { status: "not_found", notes: ["La URL indicada no es http(s)."] };
    host = u.hostname;
  } catch {
    return { status: "not_found", notes: ["La URL indicada no es válida."] };
  }
  const page = await fetchPage(claim.url);
  if (!page || !page.ok) return { status: "not_found", notes: ["No se pudo abrir la página para comprobar la cita."] };
  const meta = parseHtmlMeta(page.html);
  const best = meta.titles.map((t) => ({ t, sim: pageTitleSimilarity(claim.title, t) })).sort((x, y) => y.sim - x.sim)[0];
  if (!best || best.sim < 0.9) {
    return { status: "not_found", notes: ["La página no contiene el título citado; se descarta."], titleSimilarity: best?.sim };
  }
  let finalHost = host;
  try { finalHost = new URL(page.finalUrl).hostname; } catch { /* usar el original */ }
  const record: RegistryRecord = {
    title: best.t,
    authors: [],
    venue: finalHost,
    type: "report",
    abstract: meta.description,
    sourceUrl: page.finalUrl,
    institutional: isInstitutionalHost(finalHost),
  };
  return {
    status: "probable", // existe y el título coincide, pero sin DOI ni registro bibliográfico: nunca "exact"
    record,
    titleSimilarity: best.sim,
    notes: [`Encontrada en la web de ${finalHost}: el título coincide. No tiene DOI ni aparece en Crossref/OpenAlex.${record.institutional ? " Es la web de un organismo oficial." : ""}`],
  };
}

// ── decisión de estado ───────────────────────────────────────────────────────
export function decideStatus(claim: CitationClaim, rec: RegistryRecord, doiResolved: boolean) {
  const sim = titleSimilarity(claim.title, rec.title);
  const surname = surnameMatch(claim.author, rec.authors);
  const cy = claim.year !== undefined ? parseInt(String(claim.year), 10) : NaN;
  const yearDelta = Number.isFinite(cy) && rec.year ? Math.abs(cy - rec.year) : undefined;
  const yearOk = yearDelta !== undefined && yearDelta <= 1;

  let status: VerificationStatus = "not_found";
  if (sim >= 0.9 && surname === "first" && yearOk && doiResolved) status = "exact";
  else if (sim >= 0.9 && (surname !== "none" || yearOk)) status = "probable";
  else if (sim >= 0.8 && surname !== "none" && yearOk) status = "probable";
  else if (!claim.author && sim >= 0.95 && yearOk) status = "probable";
  return { status, sim, surname, yearDelta };
}

// ── clientes de registro ─────────────────────────────────────────────────────
export interface FetchResult {
  ok: boolean;
  status: number;
  json: any;
}
export interface RegistryOptions {
  fetchJson: (url: string) => Promise<FetchResult>;
  mailto?: string; // contacto real (CONTACT_EMAIL). Si no existe, no se envía: no se inventa
  openalexKey?: string; // OPENALEX_API_KEY (desde feb-2026 OpenAlex pide clave gratuita)
}
export interface Registry {
  crossrefByDoi(doi: string): Promise<RegistryRecord | null>;
  crossrefSearch(title: string, author?: string): Promise<RegistryRecord[]>;
  openalexByDoi(doi: string): Promise<RegistryRecord | null>;
  openalexSearch(query: string): Promise<RegistryRecord[]>;
  openalexEnabled(): boolean;
}

const RETRACTION_TYPES = new Set(["retraction", "withdrawal", "removal"]);
const CONCERN_TYPES = new Set(["expression_of_concern", "expression-of-concern", "expression of concern"]);

export function fromCrossref(m: any): RegistryRecord | null {
  const title = Array.isArray(m?.title) ? m.title[0] : m?.title;
  if (!title) return null;
  const authors = (m.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name).filter(Boolean);
  const year = m.issued?.["date-parts"]?.[0]?.[0] ?? m.published?.["date-parts"]?.[0]?.[0] ?? m["published-print"]?.["date-parts"]?.[0]?.[0];
  const updates: any[] = Array.isArray(m["updated-by"]) ? m["updated-by"] : [];
  const types = updates.map((u) => String(u?.type || "").toLowerCase());
  return {
    doi: cleanDoi(m.DOI),
    title: String(title),
    authors,
    year: typeof year === "number" ? year : undefined,
    venue: Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined,
    type: m.type,
    citedBy: typeof m["is-referenced-by-count"] === "number" ? m["is-referenced-by-count"] : undefined,
    isRetracted: types.some((t) => RETRACTION_TYPES.has(t)) || /^\s*(retracted|withdrawn)\b/i.test(String(title)),
    hasConcern: types.some((t) => CONCERN_TYPES.has(t)),
    abstract: stripJats(m.abstract),
  };
}

export function fromOpenAlex(w: any): RegistryRecord | null {
  const title = w?.display_name || w?.title;
  if (!title) return null;
  return {
    doi: cleanDoi(w.doi),
    title: String(title),
    authors: (w.authorships || []).map((a: any) => a?.author?.display_name).filter(Boolean),
    year: typeof w.publication_year === "number" ? w.publication_year : undefined,
    venue: w.primary_location?.source?.display_name || undefined,
    type: w.type,
    citedBy: typeof w.cited_by_count === "number" ? w.cited_by_count : undefined,
    isRetracted: w.is_retracted === true, // true es definitivo; false no prueba lo contrario (documentación de OpenAlex)
    abstract: reconstructAbstract(w.abstract_inverted_index),
    openAccessUrl: w.open_access?.oa_url || undefined,
  };
}

export function mergeRecords(base: RegistryRecord, extra: RegistryRecord | null): RegistryRecord {
  if (!extra) return base;
  return {
    ...base,
    abstract: base.abstract || extra.abstract,
    citedBy: base.citedBy ?? extra.citedBy,
    venue: base.venue || extra.venue,
    openAccessUrl: base.openAccessUrl || extra.openAccessUrl,
    isRetracted: base.isRetracted || extra.isRetracted,
    hasConcern: base.hasConcern || extra.hasConcern,
    type: base.type || extra.type,
  };
}

export function makeRegistry(opts: RegistryOptions): Registry {
  let oaDisabled = false; // disyuntor: si OpenAlex rechaza (401/403/429), no se insiste en este análisis
  const q = (s: string) => encodeURIComponent(s);
  const crossrefTail = opts.mailto ? `&mailto=${q(opts.mailto)}` : "";
  const oaTail = opts.openalexKey ? `&api_key=${q(opts.openalexKey)}` : "";

  const oaGet = async (url: string) => {
    if (oaDisabled) return null;
    const r = await opts.fetchJson(url);
    if (!r.ok) {
      if ([401, 403, 429].includes(r.status)) oaDisabled = true;
      return null;
    }
    return r.json;
  };

  return {
    openalexEnabled: () => !oaDisabled && !!opts.openalexKey,
    async crossrefByDoi(doi) {
      const r = await opts.fetchJson(`https://api.crossref.org/works/${q(doi)}${crossrefTail ? "?" + crossrefTail.slice(1) : ""}`);
      return r.ok ? fromCrossref(r.json?.message) : null;
    },
    async crossrefSearch(title, author) {
      const r = await opts.fetchJson(`https://api.crossref.org/works?query.bibliographic=${q(`${title} ${firstAuthorChunk(author)}`.trim())}&rows=5${crossrefTail}`);
      if (!r.ok) return [];
      return (r.json?.message?.items || []).map(fromCrossref).filter(Boolean) as RegistryRecord[];
    },
    async openalexByDoi(doi) {
      const j = await oaGet(`https://api.openalex.org/works/doi:${q(doi)}?${oaTail.slice(1)}`);
      return j ? fromOpenAlex(j) : null;
    },
    async openalexSearch(query) {
      const j = await oaGet(`https://api.openalex.org/works?search=${q(query.slice(0, 200))}&per_page=5${oaTail}`);
      return (j?.results || []).map(fromOpenAlex).filter(Boolean) as RegistryRecord[];
    },
  };
}

// ── verificación de una cita (niveles 1 y 2) ─────────────────────────────────
async function enrich(reg: Registry, rec: RegistryRecord): Promise<RegistryRecord> {
  if (!rec.doi) return rec;
  const needs = !rec.abstract || rec.citedBy === undefined;
  if (!needs && rec.isRetracted !== undefined) return rec;
  return mergeRecords(rec, reg.openalexEnabled() ? await reg.openalexByDoi(rec.doi) : null);
}

export async function verifyCitation(reg: Registry, claim: CitationClaim, fetchPage?: PageFetcher): Promise<VerificationResult> {
  const notes: string[] = [];
  if (!claim.title || normalizeText(claim.title).length < 5) return { status: "not_found", notes: ["La cita no incluye un título utilizable."] };
  const doi = cleanDoi(claim.doi);

  // 1) DOI aportado: debe resolver Y corresponder a la obra citada
  if (doi) {
    const rec = await reg.crossrefByDoi(doi);
    if (rec) {
      const d = decideStatus(claim, rec, true);
      if (d.status === "exact" || d.status === "probable") {
        return { status: d.status, record: await enrich(reg, rec), titleSimilarity: d.sim, surname: d.surname, yearDelta: d.yearDelta, notes };
      }
      notes.push(`El DOI citado corresponde a otra obra («${rec.title.slice(0, 90)}»); se descarta.`);
    } else {
      notes.push("El DOI citado no resuelve en Crossref.");
    }
  }

  // 2) búsqueda por título: solo se acepta una obra que COINCIDA con la cita (no "algo del mismo tema")
  const candidates: RegistryRecord[] = [...(await reg.crossrefSearch(claim.title, claim.author))];
  if (reg.openalexEnabled()) candidates.push(...(await reg.openalexSearch(`${claim.title} ${firstAuthorChunk(claim.author)}`.trim())));
  const ranked = candidates
    .map((c) => ({ c, sim: titleSimilarity(claim.title, c.title) }))
    .sort((a, b) => b.sim - a.sim || (b.c.doi ? 1 : 0) - (a.c.doi ? 1 : 0));
  const best = ranked[0];
  if (best && best.sim >= 0.8) {
    let rec = best.c;
    let resolved = false;
    if (rec.doi) {
      const viaCrossref = await reg.crossrefByDoi(rec.doi); // el DOI del candidato debe resolver en Crossref
      if (viaCrossref) {
        resolved = true;
        rec = mergeRecords(viaCrossref, rec);
      }
    }
    const d = decideStatus(claim, rec, resolved);
    if (d.status === "exact" || d.status === "probable") {
      return { status: d.status, record: await enrich(reg, rec), titleSimilarity: d.sim, surname: d.surname, yearDelta: d.yearDelta, notes };
    }
    notes.push(`Estudio más parecido: «${rec.title.slice(0, 90)}» (parecido ${best.sim.toFixed(2)}); el autor o el año no coinciden lo bastante.`);
  } else if (best) {
    notes.push(`Ningún estudio del registro coincide con el título citado (el más parecido tiene un parecido de ${best.sim.toFixed(2)}).`);
  } else {
    notes.push("El registro no devolvió resultados para esta cita.");
  }

  // 3) literatura gris: si hay URL, se comprueba que la página contiene el título citado
  if (claim.url && fetchPage) {
    const page = await verifyInstitutionalPage(claim, fetchPage);
    if (page.status === "probable") return { ...page, notes: [...notes, ...page.notes] };
    notes.push(...page.notes);
  }
  return { status: "not_found", notes };
}

// ── nivel 3: ¿respalda? ──────────────────────────────────────────────────────
const supportSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          verdict: { type: Type.STRING, enum: ["supports", "contradicts", "mixed", "unrelated"] },
          quote: { type: Type.STRING, description: "Frase LITERAL y corta (máx. 25 palabras) copiada del resumen que justifica el veredicto. Vacío si es 'unrelated'." },
        },
        required: ["id", "verdict"],
      },
    },
  },
  required: ["results"],
};

export interface SupportItem {
  id: string;
  claim: string;
  title: string;
  abstract?: string;
}
export type LlmJson = (prompt: string, system: string, schema: any) => Promise<string>;

export async function assessSupport(llmJson: LlmJson, items: SupportItem[], lang = "castellano"): Promise<Map<string, { verdict: SupportVerdict; quote?: string }>> {
  const out = new Map<string, { verdict: SupportVerdict; quote?: string }>();
  const withAbstract = items.filter((i) => i.abstract && i.abstract.length >= 40);
  for (const i of items) if (!withAbstract.includes(i)) out.set(i.id, { verdict: "unassessed" });
  if (!withAbstract.length) return out;

  const system = `Eres un revisor que decide si el RESUMEN de un estudio respalda una afirmación concreta. Reglas:
- Usa SOLO el texto del resumen. No uses lo que recuerdes del estudio.
- "unrelated": el resumen no trata el asunto específico de la afirmación, aunque pertenezca a la misma disciplina o al mismo tema general (p. ej. un estudio sobre flujos de fondos de inversión no respalda una afirmación sobre la sostenibilidad del sistema público de pensiones).
- "supports": los hallazgos del resumen apoyan la afirmación en el mismo sentido. "contradicts": la contradicen. "mixed": hay apoyo parcial y matices o resultados en sentidos distintos.
- "quote" debe ser una frase literal y corta del resumen. Si no puedes citar una frase literal que lo justifique, responde "unrelated".
- Aplica el mismo nivel de exigencia tanto si el estudio coincide con la afirmación como si la contradice.`;
  const body = withAbstract.map((i) => `ID: ${i.id}\nAFIRMACIÓN: ${i.claim}\nESTUDIO: ${i.title}\nRESUMEN: ${i.abstract!.slice(0, 1800)}`).join("\n\n=====\n\n");
  let results: any[] = [];
  try {
    const raw = (await llmJson(`Idioma de respuesta: ${lang}.\n\n${body}`, system, supportSchema)).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    results = JSON.parse(raw)?.results || [];
  } catch {
    results = [];
  }
  for (const it of withAbstract) {
    const r = results.find((x: any) => x?.id === it.id);
    const verdict = r?.verdict as SupportVerdict | undefined;
    if (!r || !["supports", "contradicts", "mixed", "unrelated"].includes(verdict || "")) {
      out.set(it.id, { verdict: "unassessed" });
      continue;
    }
    if (verdict === "unrelated") {
      out.set(it.id, { verdict });
      continue;
    }
    // Sin frase literal comprobable no se acepta que "respalde": evita atribuciones inventadas.
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    const okQuote = quote && quote.split(/\s+/).length <= 25 && locateFragment(quote, it.abstract!);
    out.set(it.id, okQuote ? { verdict: verdict!, quote } : { verdict: "unassessed" });
  }
  return out;
}

// ── fiabilidad derivada de una rúbrica (sin mínimos ni valores por defecto) ──
export type StudyDesign = "systematic_review" | "rct" | "cohort" | "case_control" | "cross_sectional" | "case_series" | "expert_opinion" | "modeling_theory" | "unknown";
const DESIGN_POINTS: Record<StudyDesign, number> = {
  systematic_review: 35, rct: 30, cohort: 22, case_control: 18, cross_sectional: 12, modeling_theory: 12, case_series: 6, expert_opinion: 4, unknown: 10,
};

export interface Reliability {
  score: number | null; // null = no evaluable
  basis: string[];
}

export function scoreReliability(rec: RegistryRecord | undefined, status: VerificationStatus, design: StudyDesign = "unknown"): Reliability {
  if (!rec || (status !== "exact" && status !== "probable")) {
    return { score: null, basis: ["No se puede puntuar: la obra no está comprobada en ningún registro."] };
  }
  if (rec.isRetracted) return { score: 0, basis: ["El estudio ha sido retirado por la revista (retractado)."] };
  const basis: string[] = ["Obra localizada y coincidente en registro (+10)"];
  let score = 10;
  const t = (rec.type || "").toLowerCase();
  let venuePts = 10;
  let venueTxt = "tipo de publicación no determinado (+10)";
  if (/journal-article|^article$/.test(t) && rec.venue) { venuePts = 30; venueTxt = `artículo de revista (${rec.venue}) (+30)`; }
  else if (/report/.test(t) && rec.institutional) { venuePts = 25; venueTxt = "informe de un organismo oficial (+25)"; }
  else if (/book|monograph|report|chapter|proceedings/.test(t)) { venuePts = 20; venueTxt = "libro, informe o actas (+20)"; }
  else if (/preprint|posted-content/.test(t)) { venuePts = 10; venueTxt = "estudio aún sin publicar en revista (preprint) o sin revisión de expertos confirmada (+10)"; }
  score += venuePts;
  basis.push(venueTxt);
  const cit = rec.citedBy ?? 0;
  const citPts = Math.min(25, Math.round(6 * Math.log10(1 + cit)));
  score += citPts;
  basis.push(`citado ${cit} veces (+${citPts}; no se tiene en cuenta la antigüedad)`);
  const dPts = DESIGN_POINTS[design] ?? 10;
  score += dPts;
  basis.push(design === "unknown" ? "diseño del estudio no determinado (+10)" : `tipo de estudio según la IA: ${design.replace("_", " ")} (+${dPts}; sin comprobar)`);
  basis.push("Replicación: no evaluada. Riesgo de sesgo, tamaño muestral y conflictos de interés: no evaluados.");
  if (rec.hasConcern) { score = Math.max(0, score - 15); basis.push("La revista ha publicado un aviso de preocupación sobre el estudio (-15)"); }
  return { score: Math.max(0, Math.min(100, score)), basis };
}

// ── orquestación ─────────────────────────────────────────────────────────────
export interface CitationInput {
  id: string;
  claim: string; // afirmación que la cita debe respaldar
  cited?: CitationClaim; // cita que propone el modelo (puede faltar)
  relatedQuery?: string; // para sugerir una lectura relacionada si la cita no sirve
  dropIfUnrelated: boolean; // posiciones críticas: sí. Fuentes bibliográficas: no (se muestra con aviso)
}
export interface CitationOutput {
  id: string;
  status: VerificationStatus;
  record?: RegistryRecord;
  support: SupportVerdict;
  supportQuote?: string;
  notes: string[];
  discarded?: { title: string; reason: string };
}

export async function resolveCitations(reg: Registry, llmJson: LlmJson, inputs: CitationInput[], lang = "castellano", opts: { fetchPage?: PageFetcher } = {}): Promise<CitationOutput[]> {
  // A) existe y coincide
  const verif = new Map<string, VerificationResult>();
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const inp = inputs[next++];
      verif.set(inp.id, inp.cited?.title ? await verifyCitation(reg, inp.cited, opts.fetchPage) : { status: "not_found", notes: [] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, inputs.length) }, worker)); // 3 a la vez: educado con Crossref/OpenAlex

  // B) respalda (una sola llamada al LLM para todas)
  const items: SupportItem[] = [];
  for (const inp of inputs) {
    const v = verif.get(inp.id)!;
    if (v.record && !v.record.isRetracted) items.push({ id: inp.id, claim: inp.claim, title: v.record.title, abstract: v.record.abstract });
  }
  const support = items.length ? await assessSupport(llmJson, items, lang) : new Map();

  // C) lecturas relacionadas: solo para entradas sin cita aprovechable, y solo si OpenAlex está disponible
  const outputs = new Map<string, CitationOutput>();
  const needRelated: CitationInput[] = [];
  for (const inp of inputs) {
    const v = verif.get(inp.id)!;
    const s = support.get(inp.id) || { verdict: "unassessed" as SupportVerdict };
    const out: CitationOutput = { id: inp.id, status: v.status, record: v.record, support: s.verdict, supportQuote: s.quote, notes: [...v.notes] };
    if (v.record?.isRetracted) {
      out.support = "unassessed";
      out.notes.push("El estudio fue retirado por la revista: no se usa como prueba.");
      if (inp.dropIfUnrelated) {
        out.discarded = { title: v.record.title, reason: "retractada" };
        out.record = undefined;
        out.status = "not_found";
      }
    } else if (v.record && s.verdict === "unrelated" && inp.dropIfUnrelated) {
      out.discarded = { title: v.record.title, reason: "el resumen del estudio no trata este argumento" };
      out.record = undefined;
      out.status = "not_found";
    }
    if (!out.record && inp.relatedQuery) needRelated.push(inp);
    outputs.set(inp.id, out);
  }

  if (needRelated.length && reg.openalexEnabled()) {
    const cands = new Map<string, RegistryRecord[]>();
    const relItems: SupportItem[] = [];
    for (const inp of needRelated) {
      const found = (await reg.openalexSearch(inp.relatedQuery!)).filter((r) => r.abstract && !r.isRetracted).slice(0, 3);
      cands.set(inp.id, found);
      found.forEach((r, i) => relItems.push({ id: `${inp.id}#${i}`, claim: inp.claim, title: r.title, abstract: r.abstract }));
    }
    const relSupport = relItems.length ? await assessSupport(llmJson, relItems, lang) : new Map();
    for (const inp of needRelated) {
      const list = cands.get(inp.id) || [];
      for (let i = 0; i < list.length; i++) {
        const s = relSupport.get(`${inp.id}#${i}`);
        if (s && (s.verdict === "supports" || s.verdict === "mixed" || s.verdict === "contradicts")) {
          const prev = outputs.get(inp.id)!;
          outputs.set(inp.id, {
            ...prev,
            status: "related_unverified", // sin sello: sugerida por búsqueda, no es la cita del modelo
            record: list[i],
            support: s.verdict,
            supportQuote: s.quote,
            notes: [...prev.notes, "Lectura relacionada que sugirió una búsqueda automática; no está comprobado que apoye esta afirmación."],
          });
          break;
        }
      }
    }
  }
  return inputs.map((i) => outputs.get(i.id)!);
}
