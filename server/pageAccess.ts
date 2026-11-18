// Acceso a páginas web desde el servidor: lectura con reintento, detección de bloqueos anti-robot
// y, para podcasts, respaldo por el feed RSS del programa (que suele estar abierto aunque la web no lo esté).
//
// Por qué existe: algunas webs (p. ej. con protección tipo SiteGround, Cloudflare o Wordfence) devuelven a los
// servidores en la nube una página de espera casi vacía con código 200 o 202. La app la leía como «página sin
// texto» y fallaba con un error genérico, o peor, analizaba solo el título de la URL.
import * as cheerio from "cheerio";
import { HttpError } from "./security";
import { safeFetch } from "./safeFetch";

/** La web no deja leer su contenido desde el servidor (bloqueo anti-robot, página vacía…). Se devuelve como 422 con un mensaje claro. */
export class PageBlockedError extends HttpError {
  constructor(message: string, public reason: string, public upstreamStatus: number) {
    super(422, message);
    this.name = "PageBlockedError";
  }
}

export interface PageResult {
  status: number;
  ok: boolean;
  html: string;
  finalUrl: string;
  blockedReason: string | null;
}

export type TextFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; ok: boolean; text: string; finalUrl: string }>;

export function simpleHeaders(): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  };
}

/** Cabeceras más parecidas a las de un navegador real (segundo intento). */
export function browserHeaders(url: string): Record<string, string> {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    /* sin referer */
  }
  return {
    ...simpleHeaders(),
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    ...(origin ? { Referer: `${origin}/` } : {}),
  };
}

const defaultFetcher: TextFetcher = async (url, headers) => {
  const r = await safeFetch(url, { headers, maxBytes: 8 * 1024 * 1024 });
  return { status: r.status, ok: r.ok, text: await r.text(), finalUrl: r.finalUrl };
};

/** Devuelve el motivo si la respuesta parece un bloqueo anti-robot o una página vacía; null si parece contenido real. */
export function detectBlock(status: number, html: string): string | null {
  if ([401, 403, 429, 503].includes(status)) return `la web respondió con el código ${status}`;
  const head = (html || "").slice(0, 8000);
  const $ = cheerio.load(html || "");
  const visible = $("body").text().replace(/\s+/g, " ").trim();
  let refresh = "";
  $("meta").each((_, el) => {
    if (($(el).attr("http-equiv") || "").toLowerCase() === "refresh") refresh = $(el).attr("content") || "";
  });
  if (/sgcaptcha|captcha|\/cdn-cgi\/|cf-chl|g-recaptcha|hcaptcha/i.test(head) && visible.length < 500) {
    return "la web pide comprobar que no eres un robot";
  }
  if (/just a moment|attention required|access denied|enable javascript and cookies|checking your browser/i.test(visible) && visible.length < 700) {
    return "la web muestra una comprobación anti-robots";
  }
  if (status === 202) return "la web devolvió una página de espera (código 202)";
  if (refresh && visible.length < 120) return "la web redirige a una página de espera";
  if (visible.length < 40 && $("article, main, p").length === 0) return "la web devolvió una página vacía";
  return null;
}

/** Lee una página; si parece bloqueada, reintenta una vez con cabeceras de navegador. */
export async function fetchPage(url: string, fetcher: TextFetcher = defaultFetcher): Promise<PageResult> {
  const first = await fetcher(url, simpleHeaders());
  let reason = detectBlock(first.status, first.text);
  if (!reason && first.ok) return { status: first.status, ok: true, html: first.text, finalUrl: first.finalUrl, blockedReason: null };

  const second = await fetcher(url, browserHeaders(url)).catch(() => null);
  if (second) {
    const reason2 = detectBlock(second.status, second.text);
    if (!reason2 && second.ok) return { status: second.status, ok: true, html: second.text, finalUrl: second.finalUrl, blockedReason: null };
    reason = reason2 || reason;
    return { status: second.status, ok: false, html: second.text, finalUrl: second.finalUrl, blockedReason: reason || `la web respondió con el código ${second.status}` };
  }
  return { status: first.status, ok: false, html: first.text, finalUrl: first.finalUrl, blockedReason: reason || `la web respondió con el código ${first.status}` };
}

// ───────────────────────── Respaldo: feed RSS del podcast ─────────────────────────

export interface FeedEpisode {
  title: string;
  description: string;
  audioUrl: string;
  link: string;
}

/** URLs de feed a probar: las que anuncia la página (si la hay) y las rutas habituales de WordPress/Seriously Simple Podcasting. */
export function feedUrlCandidates(pageUrl: string, html = ""): string[] {
  const out: string[] = [];
  const add = (raw?: string) => {
    if (!raw) return;
    try {
      const u = new URL(raw, pageUrl).toString();
      if (/^https?:/i.test(u) && !out.includes(u)) out.push(u);
    } catch {
      /* ignorar */
    }
  };
  if (html) {
    const $ = cheerio.load(html);
    $('link[rel="alternate"]').each((_, el) => {
      const type = ($(el).attr("type") || "").toLowerCase();
      if (type.includes("rss") || type.includes("atom") || type.includes("xml")) add($(el).attr("href"));
    });
  }
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return out;
  }
  for (const p of ["/feed/podcast/", "/feed/podcast", "/podcast/feed/", "/feed/"]) add(origin + p);
  // los feeds de podcast van primero: tienen el audio
  return out.sort((a, b) => Number(/podcast/i.test(b)) - Number(/podcast/i.test(a))).slice(0, 5);
}

const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};
const lastSegment = (u: string) => {
  try {
    return new URL(u).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
};

/** Busca en el XML de un feed el episodio que corresponde a la URL de la página. */
export function findEpisodeInFeed(xml: string, pageUrl: string): FeedEpisode | null {
  if (!/<item[\s>]/i.test(xml)) return null;
  const $ = cheerio.load(xml, { xmlMode: true });
  const wantPath = normUrl(pageUrl);
  const wantSlug = lastSegment(pageUrl).toLowerCase();
  let found: FeedEpisode | null = null;
  $("item").each((_, el) => {
    if (found) return;
    const item = $(el);
    const link = item.children("link").first().text().trim();
    const guid = item.children("guid").first().text().trim();
    const slugMatch = wantSlug.length > 6 && (lastSegment(link).toLowerCase() === wantSlug || guid.toLowerCase().includes(wantSlug));
    if (!(normUrl(link) === wantPath || slugMatch)) return;
    const audioUrl = (item.children("enclosure").first().attr("url") || "").trim();
    if (!audioUrl) return;
    const raw =
      item.children("content\\:encoded").first().text() ||
      item.children("description").first().text() ||
      item.children("itunes\\:summary").first().text() ||
      "";
    const description = cheerio.load(`<div>${raw}</div>`)("div").text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    found = { title: item.children("title").first().text().trim(), description, audioUrl, link };
  });
  return found;
}

/** Intenta localizar el episodio en los feeds del sitio. Devuelve null si ningún feed responde o no contiene ese episodio. */
export async function fetchEpisodeFromFeed(pageUrl: string, html = "", fetcher: TextFetcher = defaultFetcher): Promise<FeedEpisode | null> {
  for (const feedUrl of feedUrlCandidates(pageUrl, html)) {
    try {
      const r = await fetcher(feedUrl, browserHeaders(feedUrl));
      if (!r.ok || !/<item[\s>]/i.test(r.text)) continue;
      const ep = findEpisodeInFeed(r.text, pageUrl);
      if (ep) return ep;
    } catch {
      /* este feed no responde: se prueba el siguiente */
    }
  }
  return null;
}

/** Mensaje claro para el usuario cuando no hay forma de leer la página. */
export function blockedMessage(reason: string, status: number, looksLikePodcast: boolean): string {
  const base = `No se pudo leer la página: ${reason}${status ? ` (código ${status})` : ""}. Es la web la que bloquea las lecturas automáticas desde servidores, no un fallo del análisis.`;
  const options = looksLikePodcast
    ? " Opciones: 1) pega la dirección directa del audio (el enlace «Descarga» del episodio, que acaba en .mp3 o .m4a); 2) pega el texto o las notas en la pestaña «Pegar texto»."
    : " Opciones: pega el texto en la pestaña «Pegar texto» o sube el documento o una captura.";
  return base + options;
}
