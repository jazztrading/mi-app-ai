import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedMessage,
  deburr,
  detectBlock,
  directorySearchTerms,
  episodeKey,
  fetchEpisodeViaDirectory,
  locateEpisode,
  parseDirectoryResults,
  feedUrlCandidates,
  fetchEpisodeFromFeed,
  fetchPage,
  findEpisodeInFeed,
  type TextFetcher,
} from "../server/pageAccess";

const EP = "https://www.joseantoniomarina.net/el-panoptico-podcast/ep-5x03-la-vivienda-como-problema-filosofico/";
const M4A = "https://d3ctxlq1ktw2nl.cloudfront.net/staging/2026-10-20/aaa-44100-2-bbb.m4a";

const SG_CAPTCHA = `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fel-panoptico-podcast%2F"></head><body></body></html>`;
const CLOUDFLARE = `<html><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing the site.</h1></body></html>`;
const REAL = `<html><body><article><h1>Ep. 5x03</h1><p>${"Texto real del episodio. ".repeat(30)}</p></article></body></html>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>El Panóptico</title>
<item><title>Ep. 5x04: Otro episodio</title><link>https://www.joseantoniomarina.net/el-panoptico-podcast/ep-5x04-otro/</link>
<enclosure url="https://cdn.example.org/otro.mp3" length="1" type="audio/mpeg"/></item>
<item><title>Ep. 5×03: La vivienda como problema filosófico</title>
<link>${EP}</link><guid isPermaLink="false">18620 at https://www.joseantoniomarina.net</guid>
<description><![CDATA[<p>Resumen corto.</p>]]></description>
<content:encoded><![CDATA[<p>Hablamos de la <strong>vivienda</strong> como problema filosófico.</p><p>Segundo párrafo.</p>]]></content:encoded>
<enclosure url="${M4A}" length="52000000" type="audio/mp4"/></item>
</channel></rss>`;

test("detectBlock reconoce la página de espera con meta-refresh (código 200 o 202) y las comprobaciones anti-robot", () => {
  assert.match(detectBlock(202, SG_CAPTCHA) || "", /robot|espera/i);
  assert.match(detectBlock(200, SG_CAPTCHA) || "", /robot|espera|vacía/i);
  assert.match(detectBlock(200, CLOUDFLARE) || "", /anti-robots/i);
  assert.match(detectBlock(403, "<html><body>Forbidden</body></html>") || "", /403/);
  assert.match(detectBlock(200, "") || "", /vacía/i);
});

test("detectBlock no marca como bloqueada una página real ni una corta pero con contenido", () => {
  assert.equal(detectBlock(200, REAL), null);
  assert.equal(detectBlock(200, "<html><body><article><p>Una nota breve pero con párrafo de texto.</p></article></body></html>"), null);
});

test("fetchPage: bloqueada con cabeceras simples y correcta con cabeceras de navegador", async () => {
  const seen: Array<Record<string, string>> = [];
  const f: TextFetcher = async (url, headers) => {
    seen.push(headers);
    return headers["Sec-Fetch-Dest"] ? { status: 200, ok: true, text: REAL, finalUrl: url } : { status: 202, ok: true, text: SG_CAPTCHA, finalUrl: url };
  };
  const r = await fetchPage(EP, f);
  assert.equal(r.ok, true);
  assert.equal(r.blockedReason, null);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].Referer, "https://www.joseantoniomarina.net/");
});

test("fetchPage: si siguen bloqueando, devuelve ok:false con el motivo (no un texto vacío)", async () => {
  const f: TextFetcher = async (url) => ({ status: 202, ok: true, text: SG_CAPTCHA, finalUrl: url });
  const r = await fetchPage(EP, f);
  assert.equal(r.ok, false);
  assert.ok(r.blockedReason);
});

test("fetchPage: una página correcta se lee con una sola petición", async () => {
  let n = 0;
  const f: TextFetcher = async (url) => (n++, { status: 200, ok: true, text: REAL, finalUrl: url });
  const r = await fetchPage(EP, f);
  assert.equal(r.ok, true);
  assert.equal(n, 1);
});

test("feedUrlCandidates: anuncia primero los feeds de podcast, sin duplicados y con rutas relativas", () => {
  const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" href="/feed/podcast/"></head>`;
  const c = feedUrlCandidates(EP, html);
  assert.equal(c[0], "https://www.joseantoniomarina.net/feed/podcast/");
  assert.equal(new Set(c).size, c.length);
  assert.ok(c.includes("https://www.joseantoniomarina.net/feed/"));
  assert.ok(feedUrlCandidates(EP).length >= 3, "sin HTML usa las rutas habituales");
});

test("findEpisodeInFeed localiza el episodio por su enlace, extrae el audio y limpia el HTML de la descripción", () => {
  const ep = findEpisodeInFeed(FEED, EP);
  assert.ok(ep);
  assert.equal(ep!.audioUrl, M4A);
  assert.match(ep!.title, /vivienda/);
  assert.match(ep!.description, /vivienda como problema filosófico/);
  assert.ok(!/<p>|<strong>/.test(ep!.description));
  assert.equal(findEpisodeInFeed(FEED, "https://www.joseantoniomarina.net/el-panoptico-podcast/ep-9x99-no-existe-este/"), null);
  assert.equal(findEpisodeInFeed("<html>no es un feed</html>", EP), null);
});

test("findEpisodeInFeed también casa por el último tramo de la URL (www, barra final o parámetros distintos)", () => {
  const ep = findEpisodeInFeed(FEED, "https://joseantoniomarina.net/el-panoptico-podcast/ep-5x03-la-vivienda-como-problema-filosofico?utm=x");
  assert.ok(ep);
  assert.equal(ep!.audioUrl, M4A);
});

test("fetchEpisodeFromFeed: salta feeds que fallan o están bloqueados y usa el siguiente", async () => {
  const calls: string[] = [];
  const f: TextFetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/feed/podcast/")) throw new Error("timeout");
    if (url.endsWith("/feed/podcast")) return { status: 202, ok: true, text: SG_CAPTCHA, finalUrl: url };
    return { status: 200, ok: true, text: FEED, finalUrl: url };
  };
  const ep = await fetchEpisodeFromFeed(EP, "", f);
  assert.ok(ep);
  assert.equal(ep!.audioUrl, M4A);
  assert.ok(calls.length >= 3);
});

test("fetchEpisodeFromFeed: si ningún feed responde, devuelve null", async () => {
  const f: TextFetcher = async (url) => ({ status: 403, ok: false, text: "Forbidden", finalUrl: url });
  assert.equal(await fetchEpisodeFromFeed(EP, "", f), null);
});

test("blockedMessage da opciones concretas según sea o no un podcast", () => {
  assert.match(blockedMessage("la web pide comprobar que no eres un robot", 202, true), /\.m4a|\.mp3/);
  assert.match(blockedMessage("la web respondió con el código 403", 403, false), /Pegar texto/);
});

// ── Directorio de podcasts (feed alojado fuera de la web) ──
const CASTOS_FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>El Panóptico</title><link>https://www.joseantoniomarina.net/el-panoptico-podcast/</link>
<item><title>Ep. 5×04: Otro tema</title><link>https://feeds.example.org/e/otro</link><enclosure url="https://cdn.example.org/otro.mp3" type="audio/mpeg"/></item>
<item><title>Ep. 5×03: La vivienda como problema filosófico</title><link>https://feeds.example.org/e/abc123</link>
<description>Notas del episodio.</description><enclosure url="${M4A}" type="audio/mp4"/></item></channel></rss>`;
const ITUNES = JSON.stringify({ resultCount: 2, results: [
  { collectionName: "Otro programa distinto", feedUrl: "https://feeds.example.org/otro-show" },
  { collectionName: "El Panóptico", feedUrl: "https://feeds.example.org/panoptico" },
] });

test("deburr y episodeKey: sacan el código y la frase del título de la URL (×, tildes, mayúsculas)", () => {
  assert.equal(deburr("Ep. 5×03: La vivienda como problema filosófico"), "ep 5x03 la vivienda como problema filosofico");
  const k = episodeKey(EP);
  assert.equal(k.code, "5x03");
  assert.equal(k.phrase, "la vivienda como problema filosofico");
  assert.equal(k.words, 5);
});

test("directorySearchTerms toma el nombre del programa del tramo anterior al episodio", () => {
  assert.deepEqual(directorySearchTerms(EP), ["el panoptico", "el panoptico podcast"]);
  assert.deepEqual(directorySearchTerms("https://x.org/episodio-unico"), []);
});

test("parseDirectoryResults ordena primero el programa cuyo nombre coincide y descarta resultados sin feed", () => {
  const r = parseDirectoryResults(ITUNES, "el panoptico");
  assert.equal(r[0].feedUrl, "https://feeds.example.org/panoptico");
  assert.deepEqual(parseDirectoryResults("no es json", "x"), []);
  assert.deepEqual(parseDirectoryResults(JSON.stringify({ results: [{ collectionName: "A" }] }), "a"), []);
});

test("fetchEpisodeViaDirectory: encuentra el episodio en un feed alojado fuera de la web aunque la web esté bloqueada", async () => {
  const f: TextFetcher = async (url) => {
    if (url.startsWith("https://itunes.apple.com/search")) return { status: 200, ok: true, text: ITUNES, finalUrl: url };
    if (url === "https://feeds.example.org/panoptico") return { status: 200, ok: true, text: CASTOS_FEED, finalUrl: url };
    return { status: 202, ok: true, text: SG_CAPTCHA, finalUrl: url };
  };
  const ep = await fetchEpisodeViaDirectory(EP, f);
  assert.ok(ep);
  assert.equal(ep!.audioUrl, M4A);
  assert.match(ep!.title, /vivienda/);
});

test("fetchEpisodeViaDirectory: rechaza el feed de otro programa cuando el título es corto y la web no coincide", async () => {
  const otro = CASTOS_FEED.replace("https://www.joseantoniomarina.net/el-panoptico-podcast/", "https://otraweb.example.com/").replace("La vivienda como problema filosófico", "Casa y hogar");
  const f: TextFetcher = async (url) => {
    if (url.startsWith("https://itunes.apple.com/search")) return { status: 200, ok: true, text: ITUNES, finalUrl: url };
    return { status: 200, ok: true, text: otro, finalUrl: url };
  };
  assert.equal(await fetchEpisodeViaDirectory("https://www.joseantoniomarina.net/el-panoptico-podcast/ep-5x03-casa-hogar/", f), null);
});

test("locateEpisode: usa el feed de la web si funciona y, si no, el directorio; indica por dónde lo encontró", async () => {
  const soloDirectorio: TextFetcher = async (url) => {
    if (url.startsWith("https://itunes.apple.com/search")) return { status: 200, ok: true, text: ITUNES, finalUrl: url };
    if (url === "https://feeds.example.org/panoptico") return { status: 200, ok: true, text: CASTOS_FEED, finalUrl: url };
    return { status: 403, ok: false, text: "Forbidden", finalUrl: url };
  };
  const a = await locateEpisode(EP, "", soloDirectorio);
  assert.equal(a?.via, "directorio de podcasts");
  const feedPropio: TextFetcher = async (url) => (url.endsWith("/feed/podcast/") ? { status: 200, ok: true, text: FEED, finalUrl: url } : { status: 403, ok: false, text: "", finalUrl: url });
  const b = await locateEpisode(EP, "", feedPropio);
  assert.equal(b?.via, "feed de la propia web");
  const nada: TextFetcher = async (url) => ({ status: 403, ok: false, text: "", finalUrl: url });
  assert.equal(await locateEpisode(EP, "", nada), null);
});

test("blockedMessage no repite el código de estado", () => {
  const m = blockedMessage("la web devolvió una página de espera (código 202)", 202, true);
  assert.equal((m.match(/código 202/g) || []).length, 1);
  assert.match(blockedMessage("la web pide comprobar que no eres un robot", 202, true), /código 202/);
});
