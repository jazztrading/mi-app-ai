import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash, seedFromHash, stableStringify, signAnalysis, verifyFrozen, findReusable, auditedLayer } from "../server/stability";

const SECRET = "secreto-de-prueba";
const V = "v1+n1";
const mk = () => ({
  id: "analysis_1", title: "T",
  criticalPositions: [{ title: "P1", supportingStudy: { title: "Estudio", verificationStatus: "exact" } }],
  bibliographicSources: [{ title: "S1", verificationStatus: "probable", reliabilityScore: 62 }],
  scoutAssessment: { strongestVersion: "x" }, contextNotes: [{ id: "n1" }],
});

test("el hash ignora mayúsculas, puntuación y espacios, pero cambia si cambia el contenido", () => {
  const a = contentHash("Las pensiones   públicas, en España: 13% del PIB.");
  assert.equal(a, contentHash("las PENSIONES públicas en españa 13 del pib"));
  assert.notEqual(a, contentHash("Las pensiones públicas en España: 14% del PIB."));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("la semilla es estable para el mismo contenido, distinta entre contenidos y válida (entero positivo < 2^31)", () => {
  const h1 = contentHash("texto uno"), h2 = contentHash("texto dos");
  assert.equal(seedFromHash(h1), seedFromHash(contentHash("TEXTO uno")));
  assert.notEqual(seedFromHash(h1), seedFromHash(h2));
  assert.ok(Number.isInteger(seedFromHash(h1)) && seedFromHash(h1) >= 0 && seedFromHash(h1) < 2 ** 31);
});

test("stableStringify no depende del orden de las claves", () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("firma válida: se puede reutilizar para el mismo contenido y la misma versión", () => {
  const a: any = mk(); const h = contentHash("contenido");
  a.frozen = signAnalysis(SECRET, a, h, V);
  assert.equal(verifyFrozen(SECRET, a, h, V), true);
  // cambios en campos NO auditados (id, título, resumen) no invalidan la firma
  assert.equal(verifyFrozen(SECRET, { ...a, id: "analysis_9", title: "otro título editado" }, h, V), true);
});

test("MANIPULAR la capa auditada (fuente, estudio, puntuación, nota) invalida la firma", () => {
  const h = contentHash("contenido"); const a: any = mk(); a.frozen = signAnalysis(SECRET, a, h, V);
  const t1: any = structuredClone(a); t1.bibliographicSources[0].reliabilityScore = 99;
  const t2: any = structuredClone(a); t2.criticalPositions[0].supportingStudy.title = "Estudio inventado";
  const t3: any = structuredClone(a); t3.bibliographicSources.push({ title: "Fuente falsa", verificationStatus: "exact" });
  const t4: any = structuredClone(a); t4.contextNotes = [];
  for (const t of [t1, t2, t3, t4]) assert.equal(verifyFrozen(SECRET, t, h, V), false);
});

test("otro contenido, otra versión del pipeline u otro secreto NO se reutilizan", () => {
  const h = contentHash("contenido"); const a: any = mk(); a.frozen = signAnalysis(SECRET, a, h, V);
  assert.equal(verifyFrozen(SECRET, a, contentHash("contenido distinto"), V), false);
  assert.equal(verifyFrozen(SECRET, a, h, "v2+n1"), false);
  assert.equal(verifyFrozen("otro-secreto", a, h, V), false);
  assert.equal(verifyFrozen(SECRET, mk(), h, V), false, "sin firma");
  assert.equal(verifyFrozen(SECRET, { ...a, frozen: { ...a.frozen, sig: "zz" } }, h, V), false);
});

test("findReusable ignora candidatos sin firma o manipulados y devuelve el válido", () => {
  const h = contentHash("contenido");
  const good: any = mk(); good.id = "bueno"; good.frozen = signAnalysis(SECRET, good, h, V);
  const forged: any = mk(); forged.id = "falso"; forged.frozen = { ...good.frozen }; forged.bibliographicSources = [{ title: "inyectada" }];
  assert.equal(findReusable([null, mk(), forged, good], SECRET, h, V)?.id, "bueno");
  assert.equal(findReusable([forged], SECRET, h, V), null);
  assert.deepEqual(Object.keys(auditedLayer(good)).sort(), ["bibliographicSources", "contextNotes", "criticalPositions", "scoutAssessment"]);
});
