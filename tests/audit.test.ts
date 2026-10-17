import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGuards, locateFragment, runClaimAudit, rewriteWithCorrections, type AuditDeps } from "../server/audit";

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
      return { text: "EVIDENCIA INSUFICIENTE", sources: [], failed: true }; // Amodei: el buscador no devuelve nada
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
