import { test } from "node:test";
import assert from "node:assert/strict";
import { matchContextNotes, renderNotesForPrompt, snippetAround, snippetIsLiteral, CONTEXT_NOTES } from "../server/knowledge";

// Fragmentos (cortos) del artículo de ejemplo, enlazados con relleno neutro
const ARTICLE =
  "Sacrificios que no aparecen en tu nómina. El sistema público de pensiones necesita cada año recursos procedentes de los Presupuestos Generales del Estado para financiar una parte de sus obligaciones. " +
  "En 2024, el déficit básico de la Seguridad Social (incluidas las Clases Pasivas) antes de transferencias corrientes del Estado alcanzó los 67.819 millones de euros, equivalentes al 4,25% del PIB. " +
  "Mientras tanto, el Gobierno celebra el crecimiento del Fondo de Reserva de las pensiones. " + "Texto de relleno para superar la longitud mínima. ".repeat(3);

test("se activa con un texto que trata de pensiones, Seguridad Social y PGE / Clases Pasivas", () => {
  const n = matchContextNotes(ARTICLE);
  assert.equal(n.length, 1);
  assert.equal(n[0].id, "es-pensiones-fuentes-financiacion");
});

test("COMPROBACIÓN DETERMINISTA del caso: el texto SÍ menciona Clases Pasivas y PGE; NO menciona pensiones no contributivas ni complementos a mínimos", () => {
  const checks = Object.fromEntries(matchContextNotes(ARTICLE)[0].checks.map((c) => [c.label, c]));
  assert.equal(checks["Clases Pasivas"].mentioned, true);
  assert.equal(checks["Presupuestos Generales del Estado o transferencias del Estado"].mentioned, true);
  assert.equal(checks["Pensiones no contributivas"].mentioned, false);
  assert.equal(checks["Complementos de pensiones mínimas"].mentioned, false);
  assert.equal(checks["Separación de fuentes de financiación / Pacto de Toledo"].mentioned, false);
  // la prueba de cada mención es un fragmento LITERAL del texto
  assert.ok(checks["Clases Pasivas"].snippet!.includes("Clases Pasivas"));
  assert.ok(snippetIsLiteral(checks["Clases Pasivas"].snippet!, ARTICLE));
  assert.equal(checks["Pensiones no contributivas"].snippet, undefined);
});

test("no se activa con textos que no tratan el asunto (sin falsos contextos)", () => {
  assert.equal(matchContextNotes("Este artículo explica cómo funcionan los modelos de lenguaje y sus riesgos para la bioseguridad. ".repeat(4)).length, 0);
  assert.equal(matchContextNotes("Las pensiones de Estados Unidos dependen del Social Security Trust Fund y de 401k. ".repeat(4)).length, 0, "falta 'Seguridad Social' en castellano y los disparadores");
  assert.equal(matchContextNotes("").length, 0);
});

test("si el texto SÍ menciona las pensiones no contributivas, el aviso lo refleja", () => {
  const t = ARTICLE + " Además, las pensiones no contributivas y los complementos a mínimos se pagan con impuestos generales.";
  const checks = Object.fromEntries(matchContextNotes(t)[0].checks.map((c) => [c.label, c.mentioned]));
  assert.equal(checks["Pensiones no contributivas"], true);
  assert.equal(checks["Complementos de pensiones mínimas"], true);
});

test("el prompt incluye el id, la comprobación SÍ/NO y la instrucción de pedir la descomposición sin afirmar error", () => {
  const p = renderNotesForPrompt(matchContextNotes(ARTICLE));
  assert.match(p, /\[es-pensiones-fuentes-financiacion\]/);
  assert.match(p, /SÍ menciona: Clases Pasivas; Presupuestos Generales del Estado/);
  assert.match(p, /NO menciona: Pensiones no contributivas/);
  assert.match(p, /pida la descomposición de la cifra en lugar de afirmar que el texto se equivoca/);
  assert.match(p, /contextNoteIds/);
  assert.equal(renderNotesForPrompt([]), "");
});

test("integridad de la nota: cada fuente tiene URL https, tipo y qué apoya; hay cautelas; sin enlaces vacíos", () => {
  for (const n of CONTEXT_NOTES) {
    assert.ok(n.sources.length >= 2 && n.caveats.length >= 1);
    for (const s of n.sources) {
      assert.match(s.url, /^https:\/\//);
      assert.ok(["primaria", "secundaria"].includes(s.kind));
      assert.ok(s.supports.length > 20 && s.title.length > 10);
    }
    assert.ok(n.sources.some((s) => s.kind === "primaria"), "al menos una fuente primaria");
  }
});

test("snippetAround corta en límites de palabra y devuelve texto literal", () => {
  const s = snippetAround(ARTICLE, /clases pasivas/i)!;
  assert.ok(s.length < 260);
  assert.ok(snippetIsLiteral(s, ARTICLE));
});
