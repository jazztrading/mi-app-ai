// Notas de contexto curadas.
//
// Para asuntos institucionales donde el modelo puede errar de memoria y la búsqueda web no siempre está disponible,
// la app lleva notas revisadas a mano, cada una con sus fuentes. Solo se activan si el texto trata ese asunto.
// La comprobación de "qué reconoce el texto" es DETERMINISTA (expresiones regulares sobre el texto, con el fragmento
// literal como prueba): no depende del modelo. Para añadir una nota, basta con añadir un objeto a CONTEXT_NOTES.
import { normalizeText } from "./citations";

export interface NoteSource {
  title: string;
  publisher: string;
  url: string;
  kind: "primaria" | "secundaria";
  supports: string; // qué apoya esta fuente, en una frase
}

export interface ContextNote {
  id: string;
  title: string;
  reviewedAt: string; // YYYY-MM-DD
  triggers: RegExp[]; // TODOS deben cumplirse para activar la nota
  statement: string;
  whyItMatters: string;
  checks: Array<{ label: string; re: RegExp }>;
  sources: NoteSource[];
  caveats: string[];
}

export interface ContextNoteView {
  id: string;
  title: string;
  reviewedAt: string;
  statement: string;
  whyItMatters: string;
  checks: Array<{ label: string; mentioned: boolean; snippet?: string }>;
  sources: NoteSource[];
  caveats: string[];
}

export const CONTEXT_NOTES: ContextNote[] = [
  {
    id: "es-pensiones-fuentes-financiacion",
    title: "Pensiones en España: no todo el gasto se financia con cotizaciones",
    reviewedAt: "2026-10-21",
    triggers: [/pensi[oó]n|pensiones/i, /seguridad social/i, /presupuestos generales del estado|\bPGE\b|clases pasivas|no contributiv|d[eé]ficit b[aá]sico/i],
    statement:
      "En el sistema público español conviven prestaciones con distinta naturaleza y fuente de financiación. Según Hacienda, la Recomendación Primera del Pacto de Toledo 2020 establece que las prestaciones contributivas deben depender básicamente de las cotizaciones sociales y que las no contributivas y universales se financian exclusivamente con cargo a los Presupuestos Generales del Estado (PGE). El Estado transfiere además fondos a la Seguridad Social para los complementos de pensiones mínimas y para las pensiones no contributivas. Las pensiones del Régimen de Clases Pasivas del Estado (funcionarios civiles del Estado, colectivo a extinguir desde 2011) se pagan con cargo a los PGE y no las gestiona el Régimen General de la Seguridad Social.",
    whyItMatters:
      "Un saldo o 'déficit' calculado antes de las transferencias del Estado, o una deuda atribuida a la Seguridad Social, puede mezclar (a) la brecha entre cotizaciones y prestaciones contributivas y (b) gasto que por diseño se paga con impuestos. La conclusión sobre la sostenibilidad del sistema contributivo depende, por tanto, del perímetro elegido. Lo que este matiz NO cambia: se pague con cotizaciones o con impuestos, el coste lo soporta la economía y, con ello, quienes pagan impuestos y cotizaciones.",
    checks: [
      { label: "Clases Pasivas", re: /clases pasivas/i },
      { label: "Pensiones no contributivas", re: /no contributiv/i },
      { label: "Complementos de pensiones mínimas", re: /complementos? (?:a|de|por|para) (?:las )?(?:pensiones )?m[ií]nim|complementos? a m[ií]nimos/i },
      { label: "Presupuestos Generales del Estado o transferencias del Estado", re: /presupuestos generales del estado|\bPGE\b|transferencias? (?:corrientes )?del estado/i },
      { label: "Separación de fuentes de financiación / Pacto de Toledo", re: /separaci[oó]n de fuentes|pacto de toledo/i },
    ],
    sources: [
      {
        title: "Autorizadas varias transferencias de crédito para la financiación de diversas prestaciones de la Seguridad Social (Consejo de Ministros, 8 de julio de 2025)",
        publisher: "Ministerio de Hacienda",
        url: "https://www.hacienda.gob.es/en-GB/Prensa/Noticias/Paginas/2025/20250708-NP-CM-TRANSFERENCIAS-SEGURIDAD-SOCIAL.aspx",
        kind: "primaria",
        supports:
          "Recoge la Recomendación Primera del Pacto de Toledo 2020 (no contributivas y universales exclusivamente con cargo a los PGE; contributivas básicamente con cotizaciones) y autoriza transferencias del Estado para complementos de pensiones mínimas y prestaciones no contributivas (Ley 26/1990).",
      },
      {
        title: "Presupuestos Generales del Estado 2004: documento sobre pensiones de la Seguridad Social y Clases Pasivas",
        publisher: "Secretaría de Estado de Presupuestos y Gastos (Hacienda)",
        url: "https://www.sepg.pap.hacienda.gob.es/presup/PGE2004Ley/doc/6/2/3/R4L26237.PDF",
        kind: "primaria",
        supports: "Indica que las pensiones del Régimen de Clases Pasivas se financian con la aportación del Estado (además de las cuotas de los funcionarios). Documento antiguo: conviene contrastarlo con el vigente.",
      },
      {
        title: "Defendemos las pensiones de jubilación (FECCOO, 2016)",
        publisher: "Federación de Enseñanza de CCOO (fuente sindical)",
        url: "https://hemerotecate.fe.ccoo.es/assets/20160102.pdf",
        kind: "secundaria",
        supports: "Explica que Clases Pasivas forma parte del Estado, integrada en Hacienda, con recursos procedentes de los PGE, y que desde 2011 es un colectivo a extinguir.",
      },
      {
        title: "Financiación del sistema de bienestar (documento de trabajo dt-0216b)",
        publisher: "Instituto de Políticas y Bienes Públicos (CSIC)",
        url: "https://ipp.csic.es/sites/default/files/IPP/documento_trabajo/pdf/dt-0216b.pdf",
        kind: "secundaria",
        supports: "Señala que la Ley 26/1990 de pensiones no contributivas las vinculó a la financiación por el presupuesto del Estado (impuestos generales).",
      },
    ],
    caveats: [
      "Las fuentes sobre Clases Pasivas son una ley de presupuestos de 2004 y un documento sindical de 2016: conviene contrastarlas con la sección vigente de Clases Pasivas en los PGE.",
      "Esta nota no cuantifica qué parte del gasto total corresponde a cada partida: esa descomposición es lo que habría que pedir a la fuente (Hacienda, Seguridad Social, AIReF, Fedea u otra).",
      "Si el texto cita una fuente que ya descompone estas partidas, la crítica deja de aplicar: compruébalo en esa fuente.",
    ],
  },
];

/** Fragmento LITERAL del texto alrededor de la primera coincidencia (≈ 200 caracteres, cortado en límites de palabra). */
export function snippetAround(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 90);
  const end = Math.min(text.length, m.index + m[0].length + 90);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = s.replace(/^\S*\s/, "");
  if (end < text.length) s = s.replace(/\s\S*$/, "");
  return s || undefined;
}

export function matchContextNotes(text: string, notes: ContextNote[] = CONTEXT_NOTES): ContextNoteView[] {
  if (!text || text.length < 50) return [];
  const out: ContextNoteView[] = [];
  for (const n of notes) {
    if (!n.triggers.every((re) => re.test(text))) continue;
    out.push({
      id: n.id,
      title: n.title,
      reviewedAt: n.reviewedAt,
      statement: n.statement,
      whyItMatters: n.whyItMatters,
      checks: n.checks.map((c) => {
        const snippet = snippetAround(text, c.re);
        return { label: c.label, mentioned: !!snippet, snippet };
      }),
      sources: n.sources,
      caveats: n.caveats,
    });
  }
  return out;
}

export function renderNotesForPrompt(views: ContextNoteView[]): string {
  if (!views.length) return "";
  const body = views
    .map((v) => {
      const yes = v.checks.filter((c) => c.mentioned).map((c) => c.label);
      const no = v.checks.filter((c) => !c.mentioned).map((c) => c.label);
      return `[${v.id}] ${v.title}
${v.statement}
Por qué importa: ${v.whyItMatters}
Comprobación automática sobre el texto: SÍ menciona: ${yes.join("; ") || "ninguno"}. NO menciona: ${no.join("; ") || "ninguno"}.
Cautelas: ${v.caveats.join(" ")}`;
    })
    .join("\n\n");
  return `NOTAS DE CONTEXTO VERIFICADAS (revisadas a mano, con fuentes; úsalas como datos de partida, no las contradigas y no añadas cifras que no estén aquí):
${body}

INSTRUCCIÓN SOBRE LAS NOTAS: si el texto trata este asunto y mezcla o ignora la distinción descrita, formula UNA posición crítica con critiqueType "definicion_perimetro" que (1) reconozca lo que el texto SÍ recoge según la comprobación automática, (2) explique con precisión qué distinción falta, (3) pida la descomposición de la cifra en lugar de afirmar que el texto se equivoca, y (4) incluya el id de la nota en 'contextNoteIds'. Si el texto ya hace esa distinción, no formules esa crítica. Esta posición no necesita 'empiricalStudy'.`;
}

/** Utilidad para pruebas: ¿el fragmento aparece realmente en el texto? */
export const snippetIsLiteral = (snippet: string, text: string) => normalizeText(text).includes(normalizeText(snippet));
