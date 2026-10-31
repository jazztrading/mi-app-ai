import { test } from "node:test";
import assert from "node:assert/strict";
import {
  titleSimilarity, surnameMatch, cleanDoi, reconstructAbstract, decideStatus, verifyCitation, assessSupport, scoreReliability,
  resolveCitations, fromCrossref, fromOpenAlex, makeRegistry, parseHtmlMeta, isInstitutionalHost, verifyInstitutionalPage, type Registry, type RegistryRecord, type LlmJson, type PageFetcher,
} from "../server/citations";

const MARTI: RegistryRecord = {
  doi: "10.1016/j.example.2014.01.001", title: "Determinants of equity pension plan flows", authors: ["Carmen Pilar Martí Ballester"], year: 2014,
  venue: "Estudios de economía", type: "journal-article", citedBy: 14,
  abstract: "This paper analyses the determinants of net flows into equity pension plans in Spain, focusing on fund performance, fees and investor characteristics over the period 2000-2010.",
};
const PAMP: RegistryRecord = { doi: "10.1000/pamp.2015", title: "Pension Preferences and Reform – A Political-Economy Model", authors: ["Oliver Pamp"], year: 2015, venue: "Political Preferences and the Aging of Populations", type: "book-chapter", citedBy: 0, abstract: "We build a political-economy model in which voters of different ages choose the generosity of a pay-as-you-go pension system and the timing of reform." };

function fakeRegistry(opts: { byDoi?: Record<string, RegistryRecord>; search?: RegistryRecord[]; oa?: boolean; oaSearch?: RegistryRecord[] } = {}): Registry {
  return {
    openalexEnabled: () => !!opts.oa,
    crossrefByDoi: async (d) => opts.byDoi?.[d] ?? null,
    crossrefSearch: async () => opts.search ?? [],
    openalexByDoi: async () => null,
    openalexSearch: async () => opts.oaSearch ?? [],
  };
}
const llm = (fn: (body: string) => any[]): LlmJson => async (p) => JSON.stringify({ results: fn(p) });

const CLAIM = "La sostenibilidad del sistema se logra aumentando la presión fiscal sobre los jóvenes, sin reforma estructural.";

test("CASO REAL: un estudio sobre flujos de planes de pensiones en bolsa NO respalda una crítica sobre sostenibilidad pública", async () => {
  const reg = fakeRegistry({ byDoi: { [MARTI.doi!]: MARTI } });
  const out = await resolveCitations(reg, llm(() => [{ id: "p1", verdict: "unrelated", quote: "" }]), [
    { id: "p1", claim: CLAIM, cited: { title: "Determinants of equity pension plan flows", author: "Carmen Pilar Martí Ballester", year: 2014, doi: MARTI.doi }, dropIfUnrelated: true },
  ]);
  assert.equal(out[0].record, undefined, "no se muestra como evidencia");
  assert.equal(out[0].discarded?.title, "Determinants of equity pension plan flows");
  assert.match(out[0].discarded!.reason, /no trata este argumento/);
});

test("el LLM dice 'supports' pero su frase NO está en el resumen → se degrada a 'unassessed' (no se acepta respaldo sin prueba literal)", async () => {
  const m = await assessSupport(llm(() => [{ id: "a", verdict: "supports", quote: "demuestra que subir impuestos a los jóvenes garantiza la sostenibilidad" }]), [{ id: "a", claim: CLAIM, title: MARTI.title, abstract: MARTI.abstract }]);
  assert.equal(m.get("a")!.verdict, "unassessed");
});

test("respaldo aceptado solo con frase literal localizable en el resumen", async () => {
  const m = await assessSupport(llm(() => [{ id: "a", verdict: "mixed", quote: "focusing on fund performance, fees and investor characteristics" }]), [{ id: "a", claim: "x", title: MARTI.title, abstract: MARTI.abstract }]);
  assert.deepEqual(m.get("a"), { verdict: "mixed", quote: "focusing on fund performance, fees and investor characteristics" });
});

test("sin resumen no se puede juzgar: 'unassessed' y no se llama al LLM", async () => {
  let calls = 0;
  const m = await assessSupport(async () => { calls++; return "{}"; }, [{ id: "a", claim: "x", title: "t" }]);
  assert.equal(calls, 0);
  assert.equal(m.get("a")!.verdict, "unassessed");
});

test("cita exacta: DOI resuelve, título ≥0,9, primer apellido y año ±1", async () => {
  const v = await verifyCitation(fakeRegistry({ byDoi: { [MARTI.doi!]: MARTI } }), { title: "Determinants of Equity Pension Plan Flows", author: "Martí Ballester, C. P.", year: "2015", doi: `https://doi.org/${MARTI.doi}` });
  assert.equal(v.status, "exact");
});

test("un DOI que apunta a OTRA obra se descarta y nunca se adjunta", async () => {
  const v = await verifyCitation(fakeRegistry({ byDoi: { [PAMP.doi!]: PAMP } }), { title: "Determinants of equity pension plan flows", author: "Martí Ballester", year: 2014, doi: PAMP.doi });
  assert.equal(v.status, "not_found");
  assert.equal(v.record, undefined);
  assert.match(v.notes.join(" "), /corresponde a otra obra/);
});

test("una obra solo del mismo TEMA nunca pasa a exact/probable (se acabó el 'cualquier paper reciente = verificado')", async () => {
  const topical: RegistryRecord = { doi: "10.1/x", title: "Pension reform and fiscal sustainability in aging societies", authors: ["Jane Roe"], year: 2023, type: "journal-article", citedBy: 900 };
  const v = await verifyCitation(fakeRegistry({ search: [topical, PAMP] }), { title: "Sostenibilidad de las pensiones sin reforma estructural en España", author: "Autor Inventado", year: 2022 });
  assert.equal(v.status, "not_found");
  assert.equal(v.record, undefined);
});

test("sin DOI verificable la coincidencia es 'probable', no 'exact'", async () => {
  const noDoi = { ...MARTI, doi: undefined };
  const v = await verifyCitation(fakeRegistry({ search: [noDoi] }), { title: MARTI.title, author: "Martí Ballester", year: 2014 });
  assert.equal(v.status, "probable");
});

test("obra retractada: no se usa como evidencia y la fiabilidad es 0", async () => {
  const retracted = { ...MARTI, isRetracted: true };
  const out = await resolveCitations(fakeRegistry({ byDoi: { [MARTI.doi!]: retracted } }), llm(() => []), [
    { id: "p", claim: CLAIM, cited: { title: MARTI.title, author: "Martí Ballester", year: 2014, doi: MARTI.doi }, dropIfUnrelated: true },
  ]);
  assert.equal(out[0].record, undefined);
  assert.equal(out[0].discarded?.reason, "retractada");
  assert.equal(scoreReliability(retracted, "exact").score, 0);
});

test("fuentes bibliográficas: una obra real pero 'unrelated' se conserva CON aviso (no se oculta)", async () => {
  const out = await resolveCitations(fakeRegistry({ byDoi: { [MARTI.doi!]: MARTI } }), llm(() => [{ id: "s", verdict: "unrelated" }]), [
    { id: "s", claim: "El estudio demuestra X", cited: { title: MARTI.title, author: "Martí Ballester", year: 2014, doi: MARTI.doi }, dropIfUnrelated: false },
  ]);
  assert.equal(out[0].status, "exact");
  assert.equal(out[0].support, "unrelated");
  assert.ok(out[0].record);
});

test("related_unverified: solo con OpenAlex, con respaldo+frase literal, y NUNCA con sello", async () => {
  const rel: RegistryRecord = { doi: "10.2/rel", title: "Intergenerational transfers in pay-as-you-go pension systems", authors: ["A Author"], year: 2020, abstract: "Pay-as-you-go pension systems redistribute resources from younger to older cohorts, and sustainability depends on contribution rates and demographic structure." };
  const reg = fakeRegistry({ oa: true, oaSearch: [rel] });
  const l: LlmJson = async (p) => JSON.stringify({ results: p.includes("#0") ? [{ id: "p#0", verdict: "supports", quote: "sustainability depends on contribution rates and demographic structure" }] : [] });
  const out = await resolveCitations(reg, l, [{ id: "p", claim: CLAIM, cited: undefined, relatedQuery: "pension sustainability intergenerational", dropIfUnrelated: true }]);
  assert.equal(out[0].status, "related_unverified");
  assert.equal(out[0].record?.title, rel.title);
  assert.match(out[0].notes.join(" "), /no está comprobado que apoye esta afirmación/);
  // sin OpenAlex no se inventa nada
  const none = await resolveCitations(fakeRegistry({ oa: false }), l, [{ id: "p", claim: CLAIM, relatedQuery: "x", dropIfUnrelated: true }]);
  assert.equal(none[0].record, undefined);
});

test("fiabilidad por rúbrica: sin mínimos ni valor por defecto; no evaluable si no está verificada", () => {
  assert.equal(scoreReliability(undefined, "not_found").score, null);
  assert.equal(scoreReliability(MARTI, "related_unverified").score, null);
  const s = scoreReliability(MARTI, "exact");
  assert.ok(s.score! < 80, `un artículo con 14 citas y diseño desconocido no debe superar 80 (dio ${s.score})`);
  assert.ok(s.basis.some((b) => /Replicación: no evaluada/.test(b)));
  const strong = scoreReliability({ ...MARTI, citedBy: 5000 }, "exact", "systematic_review");
  assert.ok(strong.score! > s.score!);
  assert.ok(scoreReliability({ ...MARTI, type: "posted-content" }, "exact").score! < s.score!, "un preprint puntúa menos que un artículo de revista");
});

test("similitud: variaciones de puntuación ≥0,9; obras distintas <0,5", () => {
  assert.ok(titleSimilarity("Pension Preferences and Reform – A Political-Economy Model", "Pension preferences and reform: a political economy model") >= 0.9);
  assert.ok(titleSimilarity("Determinants of equity pension plan flows", "Pension Preferences and Reform – A Political-Economy Model") < 0.5);
});

test("apellidos: formatos 'Apellido, Nombre' y 'Nombre Apellido'", () => {
  assert.equal(surnameMatch("Martí Ballester, Carmen", ["Carmen Pilar Martí Ballester"]), "first");
  assert.equal(surnameMatch("Oliver Pamp y otros", ["Oliver Pamp"]), "first");
  assert.equal(surnameMatch("Pamp", ["Jane Roe", "Oliver Pamp"]), "any");
  assert.equal(surnameMatch("Nadie", ["Jane Roe"]), "none");
  assert.equal(surnameMatch(undefined, ["Jane Roe"]), "none");
});

test("utilidades: DOI, resumen invertido y mapeo de registros (retractación vía updated-by / is_retracted)", () => {
  assert.equal(cleanDoi("https://doi.org/10.1016/J.X.2014.01.001"), "10.1016/j.x.2014.01.001");
  assert.equal(cleanDoi("no-es-doi"), undefined);
  assert.equal(reconstructAbstract({ This: [0], paper: [1], studies: [2], pension: [3], flows: [4, 8], and: [5], more: [6], things: [7], really: [9], well: [10], done: [11], here: [12] }), "This paper studies pension flows and more things flows really well done here");
  const cr = fromCrossref({ DOI: "10.1/A", title: ["T"], author: [{ given: "A", family: "B" }], issued: { "date-parts": [[2020]] }, "updated-by": [{ type: "retraction", source: "retraction-watch" }] })!;
  assert.equal(cr.isRetracted, true);
  assert.equal(fromCrossref({ DOI: "10.1/A", title: ["T"], "updated-by": [{ type: "correction" }] })!.isRetracted, false);
  assert.equal(fromCrossref({ DOI: "10.1/A", title: ["Retracted: algo"] })!.isRetracted, true);
  assert.equal(fromOpenAlex({ display_name: "T", is_retracted: true })!.isRetracted, true);
});

test("registro: sin CONTACT_EMAIL no se envía mailto (no se inventa) y OpenAlex se desactiva tras un 429", async () => {
  const urls: string[] = [];
  let oaCalls = 0;
  const reg = makeRegistry({ fetchJson: async (u) => { urls.push(u); if (u.includes("openalex")) { oaCalls++; return { ok: false, status: 429, json: null }; } return { ok: true, status: 200, json: { message: { items: [] } } }; }, openalexKey: "k" });
  await reg.crossrefSearch("t", "a");
  await reg.openalexSearch("x");
  await reg.openalexSearch("y");
  assert.ok(urls.every((u) => !u.includes("mailto") && !u.includes("example.com")));
  assert.equal(oaCalls, 1, "disyuntor tras el 429");
  assert.equal(reg.openalexEnabled(), false);
});

const EC_TITLE = "The 2024 Ageing Report: Economic and Budgetary Projections for the EU Member States (2022-2070)";
const EC_HTML = `<html><head><title>2024 Ageing Report. Economic and Budgetary Projections for the EU Member States (2022-2070) - European Commission</title>
<meta name="description" content="The report presents the projections showing the economic and budgetary impact of an ageing population over the long term."></head><body><h1>2024 Ageing Report</h1></body></html>`;
const okPage = (html: string): PageFetcher => async (url) => ({ ok: true, html, finalUrl: url });

test("CASO DE TU CAPTURA: un informe real de la Comisión Europea sin DOI en registros se verifica por su página (probable, nunca exact)", async () => {
  const v = await verifyInstitutionalPage({ title: EC_TITLE, author: "European Commission (DG ECFIN)", year: 2024, url: "https://economy-finance.ec.europa.eu/publications/2024-ageing-report_en" }, okPage(EC_HTML));
  assert.equal(v.status, "probable");
  assert.equal(v.record?.institutional, true);
  assert.match(v.record!.abstract!, /economic and budgetary impact/);
  // por el flujo completo: los registros no lo conocen, la página sí
  const out = await resolveCitations(fakeRegistry(), llm(() => [{ id: "s", verdict: "supports", quote: "economic and budgetary impact of an ageing population" }]),
    [{ id: "s", claim: "Proyecta el gasto del envejecimiento en la UE", cited: { title: EC_TITLE, author: "European Commission", year: 2024, url: "https://economy-finance.ec.europa.eu/x" }, dropIfUnrelated: false }], "castellano", { fetchPage: okPage(EC_HTML) });
  assert.equal(out[0].status, "probable");
  assert.equal(out[0].support, "supports");
  assert.ok(scoreReliability(out[0].record, "probable").score! >= 30, "un informe oficial verificado no queda en 'no evaluable'");
});

test("la página institucional que NO contiene el título citado se descarta (no basta con que la URL exista)", async () => {
  const v = await verifyInstitutionalPage({ title: EC_TITLE, url: "https://ec.europa.eu/otra" }, okPage("<html><head><title>Press release: new tariffs on steel</title></head></html>"));
  assert.equal(v.status, "not_found");
  assert.equal(v.record, undefined);
  const bad = await verifyInstitutionalPage({ title: EC_TITLE, url: "https://ec.europa.eu/otra" }, async () => null);
  assert.equal(bad.status, "not_found");
  assert.equal((await verifyInstitutionalPage({ title: EC_TITLE, url: "javascript:alert(1)" }, okPage(EC_HTML))).status, "not_found");
});

test("dominios institucionales reconocidos y metadatos HTML", () => {
  for (const h of ["ec.europa.eu", "economy-finance.ec.europa.eu", "www.imf.org", "www.bde.es", "hacienda.gob.es", "www.congress.gov"]) assert.equal(isInstitutionalHost(h), true, h);
  for (const h of ["blog.example.com", "europa.eu.evil.com", "notimf.org"]) assert.equal(isInstitutionalHost(h), false, h);
  const m = parseHtmlMeta(EC_HTML);
  assert.equal(m.titles.length, 2);
  assert.ok(m.description);
});
