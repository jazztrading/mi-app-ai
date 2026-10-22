import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGuards, locateFragment, runClaimAudit as runRaw, rewriteWithCorrections, sanitizeError, parseGeminiError, type AuditDeps } from "../server/audit";
const runClaimAudit = (d: AuditDeps, i: any) => runRaw(d, i, { retryDelayMs: 0 });

const ARTICLE =
  "El reciente premio Nobel de Medicina ha recaído en Demis Hassabis, lo que muestra el avance de la IA. " +
  "Dario Amodei advirtió ante el Senado en julio de 2023 sobre los riesgos biológicos. " +
  "Creo que la regulación será un desastre. En 2030 habrá inteligencia artificial general. " +
  "Goldman Sachs estima que 300 millones de empleos están expuestos a la automatización. ".repeat(1) +
  "x".repeat(200);

const claims = [
  { claim: "El Nobel de Medicina reciente fue para Demis Hassabis", quote: "El reciente premio Nobel de Medicina ha recaído en Demis Hassabis", claimType: "fact", neutralQuestion: "¿Qué premio Nobel recibió Demis Hassabis y en qué año?", importance: 5 },
  { claim: "Amodei advirtió ante el Senado en julio de 2023", quote: "Amodei declaró literalmente que la IA es muy peligrosa", claimType: "attribution", neutralQuestion: "¿Cuándo compareció Dario Amodei ante el Senado de EE. UU.?", importance: 4 },
  { claim: "300 millones de empleos están expuestos según Goldman Sachs", quote: "Goldman Sachs estima que 300 millones de empleos están expuestos", claimType: "quantitative", neutralQuestion: "¿Cuántos empleos estima Goldman Sachs que están expuestos a la IA?", importance: 3 },
  { claim: "La regulación será un desastre", quote: "Creo que la regulación será un desastre", claimType: "opinion", neutralQuestion: "", importance: 2 },
  { claim: "En 2030 habrá IA general", quote: "En 2030 habrá inteligencia artificial general", claimType: "prediction", neutralQuestion: "", importance: 2 },
];

function makeDeps(opts: { searchCalls?: string[]; judge?: (items: string) => any[] } = {}): AuditDeps {
  return {
    llmJson: async (_p, system) => {
      if (system.includes("extrae afirmaciones")) return JSON.stringify({ claims });
      if (system.includes("verificador de hechos")) {
        return JSON.stringify({
          results: [
            // el modelo "recuerda" y respalda sin evidencia: el código debe impedirlo
            { id: "c2", verdict: "supported", confidence: 0.95, explanation: "Lo recuerdo.", evidenceQuote: "frase inventada que no está en la evidencia" },
            { id: "c1", verdict: "contradicted", confidence: 0.95, explanation: "Hassabis recibió el Nobel de Química.", correction: "Premio Nobel de Química 2024 (con John Jumper y David Baker); el de Medicina fue para Victor Ambros y Gary Ruvkun.", evidenceQuote: "recibieron el Premio Nobel de Química 2024" },
            { id: "c3", verdict: "supported", confidence: 0.95, explanation: "Coincide.", evidenceQuote: "esta cita tampoco existe en la evidencia" },
          ],
        });
      }
      return JSON.stringify({});
    },
    groundedSearch: async (prompt) => {
      opts.searchCalls?.push(prompt);
      if (prompt.includes("Hassabis"))
        return { text: "Demis Hassabis y John Jumper recibieron el Premio Nobel de Química 2024 junto con David Baker.", sources: [{ title: "NobelPrize.org", url: "https://nobelprize.org/a" }, { title: "NobelPrize.org (dup)", url: "https://nobelprize.org/a" }, { title: "Nature", url: "https://nature.com/b" }] };
      if (prompt.includes("Goldman")) return { text: "Goldman Sachs estimó que unos 300 millones de empleos a tiempo completo podrían verse afectados.", sources: [{ title: "Goldman", url: "https://goldman.com/x" }] };
      return { text: "Amodei compareció ante el Senado de EE. UU. en 2023.", sources: [] }; // texto SIN fuentes reales (el modelo "recuerda")
    },
  };
}

const input = { title: "Los mayores riesgos que plantea la IA", lang: "castellano", sourceText: ARTICLE, summary: "resumen", keyPoints: ["a", "b"] };

test("caso Nobel: la afirmación errónea queda CONTRADICHA con corrección y fuentes reales", async () => {
  const out = await runClaimAudit(makeDeps(), input);
  const nobel = out.claimChecks.find((c) => c.claim.includes("Nobel"))!;
  assert.equal(nobel.verdict, "contradicted");
  assert.match(nobel.correction!, /Química/);
  assert.equal(nobel.evidence.length, 2, "fuentes duplicadas por URL se deduplican");
  assert.equal(nobel.quoteLocated, true);
  assert.equal(nobel.evidenceQuote, "recibieron el Premio Nobel de Química 2024"); // existe de verdad en la evidencia
  assert.equal(out.status, "corrected");
  assert.match(out.summaryAudit, /1 contradichas/);
  assert.match(out.summaryAudit, /Química/);
  assert.doesNotMatch(out.summaryAudit, /100\s*%/);
  assert.equal(out.strongCorrections.length, 1);
});

test("sin fuentes reales no hay veredicto aunque el LLM diga 'supported' con 0,95", async () => {
  const out = await runClaimAudit(makeDeps(), input);
  const amodei = out.claimChecks.find((c) => c.claim.includes("Amodei"))!;
  assert.equal(amodei.verdict, "insufficient_evidence");
  assert.ok(amodei.confidence <= 0.3);
  assert.equal(amodei.evidenceQuote, undefined, "cita de evidencia inventada descartada");
  assert.equal(amodei.quoteLocated, false, "cita del artículo inventada no se muestra como literal");
  assert.equal(amodei.quote, "");
});

test("una sola fuente limita la confianza a 0,7; la cita de evidencia inexistente se descarta", async () => {
  const out = await runClaimAudit(makeDeps(), input);
  const gs = out.claimChecks.find((c) => c.claim.includes("Goldman"))!;
  assert.equal(gs.verdict, "supported");
  assert.equal(gs.confidence, 0.7);
  assert.equal(gs.evidenceQuote, undefined);
});

test("opiniones y predicciones no se buscan ni se marcan como verificadas", async () => {
  const calls: string[] = [];
  const out = await runClaimAudit(makeDeps({ searchCalls: calls }), input);
  assert.equal(calls.length, 3);
  assert.equal(out.counts.not_checkable, 2);
  assert.ok(calls.every((p) => !p.includes("desastre")));
});

test("la búsqueda es ciega: recibe la pregunta neutral, no la afirmación del autor", async () => {
  const calls: string[] = [];
  await runClaimAudit(makeDeps({ searchCalls: calls }), input);
  const nobelQ = calls.find((p) => p.includes("Hassabis"))!;
  assert.match(nobelQ, /¿Qué premio Nobel recibió Demis Hassabis/);
  assert.doesNotMatch(nobelQ, /Medicina/);
});

test("sin texto original se audita el resumen y se avisa", async () => {
  const out = await runClaimAudit(makeDeps(), { ...input, sourceText: "" });
  assert.equal(out.auditedFrom, "summary_only");
  assert.match(out.summaryAudit, /AVISO: no había texto original/);
});

test("estado 'inconclusive' si hay evidencia insuficiente y ningún error; 'verified' solo si todo respaldado", async () => {
  const mk = (verdict: string, nSources: number): AuditDeps => ({
    llmJson: async (_p, system) =>
      system.includes("extrae afirmaciones")
        ? JSON.stringify({ claims: [claims[2]] })
        : JSON.stringify({ results: [{ id: "c1", verdict, confidence: 0.9, explanation: "x" }] }),
    groundedSearch: async () => ({ text: "evidencia", sources: Array.from({ length: nSources }, (_, i) => ({ title: "t" + i, url: "https://e.com/" + i })) }),
  });
  assert.equal((await runClaimAudit(mk("supported", 2), input)).status, "verified");
  assert.equal((await runClaimAudit(mk("insufficient_evidence", 2), input)).status, "inconclusive");
  assert.equal((await runClaimAudit(mk("supported", 0), input)).status, "inconclusive");
});

test("el mismo umbral vale para respaldar y para contradecir (confianza < 0,5 → insuficiente)", () => {
  assert.equal(applyGuards({ verdict: "supported", confidence: 0.45, nSources: 3 }).verdict, "insufficient_evidence");
  assert.equal(applyGuards({ verdict: "contradicted", confidence: 0.45, nSources: 3 }).verdict, "insufficient_evidence");
  assert.equal(applyGuards({ verdict: "contradicted", confidence: 0.8, nSources: 3 }).verdict, "contradicted");
  assert.equal(applyGuards({ verdict: "supported", confidence: 7 as any, nSources: 3 }).confidence, 1);
  assert.equal(applyGuards({ verdict: "supported", confidence: NaN as any, nSources: 3 }).verdict, "insufficient_evidence");
});

test("locateFragment ignora acentos y puntuación pero no acepta texto ausente", () => {
  assert.equal(locateFragment("el reciente PREMIO Nobel de Medicina, ha recaído", ARTICLE), true);
  assert.equal(locateFragment("Amodei declaró literalmente", ARTICLE), false);
  assert.equal(locateFragment("corto", ARTICLE), false);
});

test("si el LLM juez falla, todo queda como evidencia insuficiente (no se inventa nada)", async () => {
  const deps = makeDeps();
  const bad: AuditDeps = { ...deps, llmJson: async (_p, s) => { if (s.includes("verificador")) throw new Error("boom"); return deps.llmJson(_p, s, null); } };
  const out = await runClaimAudit(bad, input);
  assert.equal(out.counts.contradicted, 0);
  assert.equal(out.counts.insufficient_evidence, 3);
});

test("reescritura: acepta cambios puntuales y rechaza reescrituras que se desvían", async () => {
  const base = { summary: "A".repeat(500), keyPoints: ["uno", "dos"], corrections: ["x → y"], lang: "castellano" };
  const ok: AuditDeps = { llmJson: async () => JSON.stringify({ executiveSummary: "B".repeat(510), keyPoints: ["uno", "dos"] }), groundedSearch: async () => ({ text: "", sources: [] }) };
  const drift: AuditDeps = { llmJson: async () => JSON.stringify({ executiveSummary: "B".repeat(100), keyPoints: ["uno", "dos"] }), groundedSearch: ok.groundedSearch };
  const lessPoints: AuditDeps = { llmJson: async () => JSON.stringify({ executiveSummary: "B".repeat(500), keyPoints: ["uno"] }), groundedSearch: ok.groundedSearch };
  assert.ok(await rewriteWithCorrections(ok, base));
  assert.equal(await rewriteWithCorrections(drift, base), null);
  assert.equal(await rewriteWithCorrections(lessPoints, base), null);
});

test("fragmento real del artículo de Ignacio de la Torre se localiza; el del dictamen antiguo no", () => {
  const real = "En la entrevista, Amodei alaba las enormes posibilidades de la IA: el reciente premio Nobel de Medicina ha recaído en Demis Hassabis, fundador de DeepMind.";
  assert.equal(locateFragment("el reciente premio Nobel de Medicina ha recaído en Demis Hassabis", real), true);
  // el dictamen antiguo atribuía a Amodei su "comparecencia ante el Senado": el artículo habla de una entrevista del Financial Times
  assert.equal(locateFragment("comparecencia ante el Subcomité Judicial del Senado", real), false);
});

test("fallo técnico de la búsqueda: no se confunde con falta de evidencia ni se dice 'ninguna contradicha'", async () => {
  let judgeCalls = 0;
  const deps: AuditDeps = {
    llmJson: async (_p, system) => {
      if (system.includes("extrae afirmaciones")) return JSON.stringify({ claims: [claims[0], claims[2]] });
      judgeCalls++;
      return JSON.stringify({ results: [] });
    },
    groundedSearch: async () => ({ text: "", sources: [], failed: true, error: '{"error":{"code":429,"message":"Quota exceeded for key AIzaSyA1234567890abcdefghijklmnop","status":"RESOURCE_EXHAUSTED"}}' }),
  };
  const out = await runClaimAudit(deps, input);
  assert.equal(judgeCalls, 0, "no se pide juicio al LLM sin evidencia");
  assert.ok(out.claimChecks.every((c) => c.searchFailed === true && c.verdict === "insufficient_evidence" && c.confidence === 0));
  assert.equal(out.coverage.searchFailed, 2);
  assert.equal(out.status, "inconclusive");
  assert.match(out.summaryAudit, /falló por un error técnico en 2 de 2/);
  assert.doesNotMatch(out.summaryAudit, /Ninguna afirmación revisada fue contradicha/);
  assert.doesNotMatch(JSON.stringify(out), /AIzaSy/, "la clave nunca se filtra al informe");
  assert.match(out.claimChecks[0].explanation, /Quota exceeded/);
});

test("si la búsqueda falla la primera vez y funciona en el reintento, la afirmación se evalúa con normalidad", async () => {
  const calls: Record<string, number> = {};
  const base = makeDeps();
  const deps: AuditDeps = {
    ...base,
    groundedSearch: async (prompt) => {
      const k = prompt.includes("Hassabis") ? "nobel" : "otra";
      calls[k] = (calls[k] || 0) + 1;
      if (k === "nobel" && calls[k] === 1) return { text: "", sources: [], failed: true, error: "429" };
      return base.groundedSearch(prompt);
    },
  };
  const out = await runClaimAudit(deps, input);
  assert.equal(calls.nobel, 2);
  const nobel = out.claimChecks.find((c) => c.claim.includes("Nobel"))!;
  assert.equal(nobel.verdict, "contradicted");
  assert.equal(nobel.searchFailed, undefined);
  assert.equal(out.coverage.searchFailed, 0);
});

test("sanitizeError extrae el mensaje JSON, oculta claves y acota la longitud", () => {
  assert.equal(sanitizeError('{"error":{"message":"cuota agotada"}}'), "cuota agotada");
  assert.doesNotMatch(sanitizeError("fallo con AIzaSyA1234567890abcdefghijklmnop dentro"), /AIza/);
  assert.ok(sanitizeError("x".repeat(1000)).length <= 200);
  assert.equal(sanitizeError(undefined), "error desconocido");
});

const DAY_429 = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.", status: "RESOURCE_EXHAUSTED", details: [
  { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { model: "gemini-flash-latest" }, quotaValue: "20" }] },
  { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "23s" }] } });
const MIN_429 = DAY_429.replace("PerDayPerProjectPerModel", "PerMinutePerProjectPerModel");

test("parseGeminiError distingue cuota diaria de cuota por minuto y extrae modelo y espera", () => {
  const d = parseGeminiError(DAY_429);
  assert.equal(d.quota, "day"); assert.equal(d.model, "gemini-flash-latest"); assert.equal(d.retryAfterSec, 23);
  assert.equal(parseGeminiError(MIN_429).quota, "minute");
  assert.equal(parseGeminiError("503 service unavailable").quota, undefined);
  assert.equal(parseGeminiError("ApiError: " + DAY_429).quota, "day", "texto delante del JSON");
  assert.equal(parseGeminiError("429 RESOURCE_EXHAUSTED sin detalle").quota, "other");
  const msg = sanitizeError(DAY_429);
  assert.match(msg, /GenerateRequestsPerDayPerProjectPerModel/);
  assert.match(msg, /medianoche, hora del Pacífico/);
  assert.match(msg, /reintentar en ~23 s/);
  assert.doesNotMatch(msg, /https?:/, "sin enlaces largos");
});

test("disyuntor: con la cuota DIARIA agotada no se lanzan más búsquedas ni segunda pasada, y el informe lo explica", async () => {
  let searches = 0;
  const many = { ...claims[2] };
  const deps: AuditDeps = {
    llmJson: async (_p, system) => (system.includes("extrae afirmaciones") ? JSON.stringify({ claims: Array.from({ length: 8 }, (_, i) => ({ ...many, claim: "afirmación " + i, importance: 3 })) }) : JSON.stringify({ results: [] })),
    groundedSearch: async () => { searches++; return { text: "", sources: [], failed: true, error: DAY_429 }; },
  };
  const out = await runClaimAudit(deps, input);
  assert.ok(searches <= 2, `se hicieron ${searches} búsquedas (máx. = concurrencia 2)`);
  assert.equal(out.coverage.quota, "day");
  assert.equal(out.coverage.searchFailed, 8);
  assert.match(out.summaryAudit, /CUOTA DIARIA DE GEMINI AGOTADA/);
  assert.match(out.claimChecks[7].explanation, /límite diario/);
});

test("cuota por minuto: se espera y se reintenta, y la afirmación acaba evaluada", async () => {
  const calls: number[] = [];
  const base = makeDeps();
  const deps: AuditDeps = { ...base, groundedSearch: async (prompt) => {
    calls.push(1);
    if (calls.length === 1) return { text: "", sources: [], failed: true, error: MIN_429 };
    return base.groundedSearch(prompt);
  } };
  const out = await runClaimAudit({ ...deps, llmJson: async (p, s) => (s.includes("extrae afirmaciones") ? JSON.stringify({ claims: [claims[0]] }) : base.llmJson(p, s, null)) }, input);
  assert.equal(out.coverage.quota, undefined);
  assert.equal(out.claimChecks[0].verdict, "contradicted");
});

test("ESTABILIDAD: con las afirmaciones congeladas no se vuelve a extraer y se auditan exactamente las mismas, en el mismo orden", async () => {
  const first = await runClaimAudit(makeDeps(), input);
  let extractionCalls = 0;
  const base = makeDeps();
  const deps: AuditDeps = { ...base, llmJson: async (p, s, sc) => { if (s.includes("extrae afirmaciones")) extractionCalls++; return base.llmJson(p, s, sc); } };
  const frozen = first.claimChecks.map((c) => ({ claim: c.claim, quote: c.quote, claimType: c.claimType, neutralQuestion: c.neutralQuestion!, importance: c.importance ?? 3 }));
  const second = await runRaw(deps, input, { retryDelayMs: 0, frozenClaims: frozen, frozenExtracted: first.coverage.extracted });
  assert.equal(extractionCalls, 0, "no se vuelve a llamar a la extracción");
  assert.deepEqual(second.claimChecks.map((c) => c.claim), first.claimChecks.map((c) => c.claim));
  assert.deepEqual(second.claimChecks.map((c) => c.id), first.claimChecks.map((c) => c.id));
  assert.deepEqual(second.claimChecks.map((c) => c.verdict), first.claimChecks.map((c) => c.verdict));
  assert.equal(second.coverage.claimsReused, true);
  assert.equal(second.coverage.extracted, first.coverage.extracted);
  assert.match(second.summaryAudit, /mismas afirmaciones de la auditoría anterior/);
  assert.equal(first.coverage.claimsReused, undefined);
});
