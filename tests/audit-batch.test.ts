import { test } from "node:test";
import assert from "node:assert/strict";
import { runClaimAudit as runRaw, createEvidenceCache, type AuditDeps } from "../server/audit";
import { buildBatchPrompt, chunkArray, findSections, parseBatchResponse } from "../server/grounding";

const TEXT = "Texto largo del artículo con varias afirmaciones comprobables. ".repeat(10);
const input = { title: "Prueba", lang: "castellano", sourceText: TEXT, summary: "resumen", keyPoints: ["a", "b"] };
const run = (d: AuditDeps, opts: any = {}) => runRaw(d, input, { retryDelayMs: 0, ...opts });

const mkClaims = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    claim: `Afirmación comprobable número ${i + 1}`,
    quote: "",
    claimType: "fact",
    neutralQuestion: `¿Qué dicen las fuentes sobre el dato ${i + 1}?`,
    importance: 5 - Math.min(4, Math.floor(i / 2)),
  }));

const llm = (n: number): AuditDeps["llmJson"] => async (_p, system) => {
  if (system.includes("extrae afirmaciones")) return JSON.stringify({ claims: mkClaims(n) });
  // juez: respalda todas las que reciben evidencia (el código aplica sus propias reglas de fuentes)
  const ids = [...(_p.match(/^ID: (c\d+)/gm) || [])].map((x) => x.replace("ID: ", ""));
  return JSON.stringify({ results: ids.map((id) => ({ id, verdict: "supported", confidence: 0.9, explanation: "Coincide." })) });
};

const okResult = (id: string) => ({ text: `Respuesta de ${id}`, sources: [{ title: "Fuente " + id, url: "https://e.org/" + id }, { title: "Otra " + id, url: "https://f.org/" + id }] });
const GENERIC_429 = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}';

test("8 afirmaciones se verifican con 2 peticiones agrupadas (no 8) y cada una recibe solo sus fuentes", async () => {
  const batches: string[][] = [];
  const deps: AuditDeps = {
    llmJson: llm(8),
    groundedSearch: async () => { throw new Error("no debe usarse la búsqueda individual"); },
    groundedSearchBatch: async (items) => {
      batches.push(items.map((i) => i.id));
      return { results: Object.fromEntries(items.map((i) => [i.id, okResult(i.id)])) };
    },
  };
  const out = await run(deps);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b) => b.length).sort(), [4, 4]);
  assert.equal(out.counts.supported, 8);
  const c5 = out.claimChecks.find((c) => c.id === "c5")!;
  assert.ok(c5.evidence.every((e) => e.url.endsWith("/c5")), "las fuentes de c5 son las de c5, no las de otra afirmación");
});

test("cuota agotada (429 genérico): se corta, no hay segunda pasada y el informe lo explica con claridad", async () => {
  let calls = 0;
  const deps: AuditDeps = {
    llmJson: llm(8),
    groundedSearch: async () => ({ text: "", sources: [] }),
    groundedSearchBatch: async () => { calls++; return { results: {}, failed: true, error: GENERIC_429 }; },
  };
  const out = await run(deps);
  assert.ok(calls <= 2, `se hicieron ${calls} peticiones (máx. = concurrencia 2, sin segunda pasada)`);
  assert.equal(out.coverage.quota, "other");
  assert.equal(out.coverage.searchFailed, 8);
  assert.match(out.summaryAudit, /LÍMITE DE USO DE GEMINI/);
  assert.match(out.summaryAudit, /solo se repetirán las que fallaron/);
  assert.ok(out.claimChecks.every((c) => /límite de uso de Gemini/.test(c.explanation)));
  assert.doesNotMatch(JSON.stringify(out.claimChecks), /exceeded your current quota/, "el texto técnico en inglés no se repite 8 veces");
});

test("memoria de evidencia: volver a comprobar no repite las búsquedas que ya funcionaron", async () => {
  const cache = createEvidenceCache();
  let calls = 0;
  const deps: AuditDeps = {
    llmJson: llm(8),
    groundedSearch: async () => ({ text: "", sources: [] }),
    groundedSearchBatch: async (items) => { calls++; return { results: Object.fromEntries(items.map((i) => [i.id, okResult(i.id)])) }; },
  };
  await run(deps, { evidenceCache: cache });
  assert.equal(calls, 2);
  const again = await run(deps, { evidenceCache: cache });
  assert.equal(calls, 2, "la segunda comprobación no gasta ninguna petición de búsqueda");
  assert.equal(again.counts.supported, 8);
});

test("tras un fallo parcial, al volver a comprobar solo se repite lo que falló", async () => {
  const cache = createEvidenceCache();
  const seen: string[][] = [];
  let healthy = false;
  const deps: AuditDeps = {
    llmJson: llm(8),
    groundedSearch: async () => ({ text: "", sources: [] }),
    groundedSearchBatch: async (items) => {
      seen.push(items.map((i) => i.question));
      const ids = items.map((i) => i.id);
      // el primer grupo (c1-c4) funciona siempre; el segundo (c5-c8) falla hasta que "se recupere"
      if (!healthy && ids.includes("c5")) return { results: {}, failed: true, error: "503 service unavailable" };
      return { results: Object.fromEntries(items.map((i) => [i.id, okResult(i.id)])) };
    },
  };
  const first = await run(deps, { evidenceCache: cache });
  assert.equal(first.coverage.searchFailed, 4);
  assert.equal(first.counts.supported, 4);
  seen.length = 0;
  healthy = true;
  const second = await run(deps, { evidenceCache: cache });
  assert.equal(seen.length, 1, "una sola petición agrupada, solo con las 4 que fallaron");
  assert.equal(seen[0].length, 4);
  assert.equal(second.coverage.searchFailed, 0);
  assert.equal(second.counts.supported, 8);
});

test("si el buscador omite la sección de una afirmación, esa afirmación se marca como fallo (no como 'sin evidencia') y se reintenta", async () => {
  let call = 0;
  const deps: AuditDeps = {
    llmJson: llm(4),
    groundedSearch: async () => ({ text: "", sources: [] }),
    groundedSearchBatch: async (items) => {
      call++;
      const results = Object.fromEntries(items.filter((i) => !(call === 1 && i.id === "c3")).map((i) => [i.id, okResult(i.id)]));
      return { results };
    },
  };
  const out = await run(deps);
  assert.equal(call, 2, "una segunda pasada con la afirmación omitida");
  assert.equal(out.coverage.searchFailed, 0);
  assert.equal(out.counts.supported, 4);
});

test("sin groundedSearchBatch se mantiene el comportamiento anterior (una búsqueda por afirmación)", async () => {
  let calls = 0;
  const deps: AuditDeps = { llmJson: llm(3), groundedSearch: async () => { calls++; return { text: "evidencia", sources: [{ title: "t", url: "https://e.org/1" }, { title: "u", url: "https://e.org/2" }] }; } };
  await run(deps);
  assert.equal(calls, 3);
});

// ── grounding.ts ──
test("findSections reconoce los marcadores ### [c1] y descarta ids desconocidos", () => {
  const t = "### [c1]\nRespuesta uno.\n\n### [c2]\nRespuesta dos.\n### [c9]\nIntruso.";
  const r = findSections(t, ["c1", "c2"]);
  assert.deepEqual(r.map((x) => x.id), ["c1", "c2"]);
});

test("parseBatchResponse reparte las fuentes por sección usando groundingSupports (también con tildes y offsets en bytes)", () => {
  const text = "### [c1]\nEl Banco de España publicó la cifra más baja desde 1982.\n\n### [c2]\nLas exportaciones de diésel se duplicaron en un mes.\n";
  const seg1 = "El Banco de España publicó la cifra más baja desde 1982.";
  const seg2 = "Las exportaciones de diésel se duplicaron en un mes.";
  const chunks = [{ web: { uri: "https://bde.es/a", title: "BdE" } }, { web: { uri: "https://eia.gov/b", title: "EIA" } }, { web: { uri: "https://x.org/c", title: "X" } }];
  const startBytes = Buffer.from(text.slice(0, text.indexOf(seg2)), "utf8").length;
  const supports = [
    { segment: { text: seg1 }, groundingChunkIndices: [0] },
    { segment: { text: seg2, startIndex: startBytes }, groundingChunkIndices: [1, 2] },
    { segment: { text: "texto que no está" }, groundingChunkIndices: [0] },
  ];
  const r = parseBatchResponse(text, ["c1", "c2"], chunks, supports);
  assert.deepEqual(r.c1.sources.map((s) => s.url), ["https://bde.es/a"]);
  assert.deepEqual(r.c2.sources.map((s) => s.url), ["https://eia.gov/b", "https://x.org/c"]);
  assert.match(r.c1.text, /Banco de España/);
});

test("parseBatchResponse: una sección ausente o vacía no aparece; sin supports no se inventan fuentes", () => {
  const r = parseBatchResponse("### [c1]\nSolo la primera.\n### [c2]\n", ["c1", "c2", "c3"], [{ web: { uri: "https://a.org" } }], undefined);
  assert.deepEqual(Object.keys(r), ["c1"]);
  assert.equal(r.c1.sources.length, 0);
});

test("buildBatchPrompt incluye todas las preguntas con su id; chunkArray divide sin perder elementos", () => {
  const p = buildBatchPrompt([{ id: "c1", question: "¿A?" }, { id: "c2", question: "¿B?" }]);
  assert.match(p, /\[c1\] ¿A\?/);
  assert.match(p, /\[c2\] ¿B\?/);
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
