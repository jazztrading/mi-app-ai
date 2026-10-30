import { test } from "node:test";
import assert from "node:assert/strict";
import {
  END_MARKER,
  downloadFirstAudio,
  findAudioCandidates,
  isDirectAudioUrl,
  mimeCandidatesFor,
  transcribeImages,
  transcribeYouTubeVideo,
} from "../server/media";
import { safeDownload, UnsafeUrlError } from "../server/safeFetch";

const M4A = "https://d3ctxlq1ktw2nl.cloudfront.net/staging/2026-9-8/433672626-44100-2-f4fc366266284.m4a";
const PAGE = "https://www.joseantoniomarina.net/el-panoptico-podcast/ep-5x01-centro-de-vacunacion-contra-la-insensatez/";

// Estructura real de la página de El Panóptico (plugin Seriously Simple Podcasting): el audio solo aparece en
// un enlace "Descarga", en el title de una imagen y como URL suelta; el reproductor no lleva <audio src>.
const PANOPTICO_HTML = `
<html><head><meta property="og:title" content="Ep. 5x01"></head><body>
<article><h1>Ep. 5×01: Centro de vacunación contra la insensatez</h1>
<p>Bienvenidos a la 5ª Temporada de El Panóptico.</p>
<h3>Acceso al podcast</h3>
<img src="https://www.joseantoniomarina.net/wp-content/uploads/2026/10/Caratula-150x150.png" alt="${M4A}" title="${M4A}">
<div class="ssp-player">${M4A}</div>
<a href="https://www.joseantoniomarina.net/podcast-download/18486/ep-5x01-centro-de-vacunacion-contra-la-insensatez?ref=new_window">Reproducir en una nueva ventana</a>
<a href="${M4A}" title="Descarga">Descarga</a>
</article></body></html>`;

test("findAudioCandidates localiza el .m4a de El Panóptico y lo pone antes que el enlace de descarga", () => {
  const c = findAudioCandidates(PANOPTICO_HTML, PAGE);
  assert.equal(c[0], M4A);
  assert.equal(c.filter((u) => u === M4A).length, 1, "sin duplicados");
  assert.ok(c.some((u) => u.includes("/podcast-download/18486/")), "conserva la descarga con redirección como alternativa");
  assert.ok(c.indexOf(M4A) < c.findIndex((u) => u.includes("/podcast-download/")));
});

test("findAudioCandidates: og:audio, <audio>, JSON-LD y rutas relativas", () => {
  const html = `<head>
    <meta property="og:audio" content="/media/ep1.mp3?x=1&amp;y=2">
    <script type="application/ld+json">{"@type":"PodcastEpisode","associatedMedia":{"@type":"AudioObject","contentUrl":"https://cdn.example.org/a/ep2.ogg"}}</script>
  </head><body><audio controls><source src="stream/ep3.wav"></audio></body>`;
  const c = findAudioCandidates(html, "https://example.org/podcast/ep/");
  assert.ok(c.includes("https://example.org/media/ep1.mp3?x=1&y=2"));
  assert.ok(c.includes("https://cdn.example.org/a/ep2.ogg"));
  assert.ok(c.includes("https://example.org/podcast/ep/stream/ep3.wav"));
});

test("findAudioCandidates: una página sin audio devuelve lista vacía y no falla con JSON-LD roto", () => {
  const html = `<html><head><script type="application/ld+json">{roto</script></head><body><p>Un artículo normal.</p><a href="/otra-pagina">x</a></body></html>`;
  assert.deepEqual(findAudioCandidates(html, "https://example.org/blog/post"), []);
});

test("isDirectAudioUrl y mimeCandidatesFor", () => {
  assert.equal(isDirectAudioUrl(`${M4A}?token=1`), true);
  assert.equal(isDirectAudioUrl("https://example.org/podcast-download/1/ep"), false);
  assert.equal(isDirectAudioUrl("no es una url"), false);
  assert.deepEqual(mimeCandidatesFor(M4A, "audio/x-m4a").slice(0, 3), ["audio/m4a", "audio/mp4", "audio/aac"]);
  assert.ok(mimeCandidatesFor(M4A, "audio/x-m4a").includes("audio/x-m4a"));
  assert.deepEqual(mimeCandidatesFor("https://x.org/e.mp3"), ["audio/mp3", "audio/mpeg"]);
  assert.ok(mimeCandidatesFor("https://x.org/stream").length >= 2, "sin extensión: alternativas por defecto");
});

test("safeDownload y downloadFirstAudio rechazan destinos internos sin tocar la red", async () => {
  await assert.rejects(() => safeDownload("http://127.0.0.1/a.mp3", "/tmp/x.bin"), UnsafeUrlError);
  await assert.rejects(() => safeDownload("http://169.254.169.254/latest/meta-data", "/tmp/x.bin"), UnsafeUrlError);
  const r = await downloadFirstAudio(["http://localhost/a.mp3", "http://10.0.0.5/b.mp3"]);
  assert.equal(r.audio, null);
  assert.equal(r.errors.length, 2);
});

// ── Gemini simulado ──
function fakeAi(responses: Array<{ text?: string; finishReason?: string; throws?: string }>, calls: any[] = []) {
  let i = 0;
  return {
    calls,
    ai: {
      models: {
        generateContent: async (req: any) => {
          calls.push(req);
          const r = responses[Math.min(i++, responses.length - 1)];
          if (r.throws) throw new Error(r.throws);
          return { text: r.text ?? "", candidates: [{ finishReason: r.finishReason || "STOP" }] };
        },
      },
    } as any,
  };
}

test("transcribeYouTubeVideo: una pasada con marca de fin → completa y sin la marca en el texto", async () => {
  const { ai, calls } = fakeAi([{ text: `[00:00] Voz 1: Hola a todos.\n\n[00:05] Voz 1: Empezamos.\n${END_MARKER}` }]);
  const r = await transcribeYouTubeVideo({ ai, models: ["m1"] }, "https://www.youtube.com/watch?v=abc");
  assert.equal(r.complete, true);
  assert.equal(r.passes, 1);
  assert.ok(!r.text.includes("FIN DE LA TRANSCRIPCIÓN"));
  assert.ok(r.text.includes("Empezamos."));
  assert.equal(calls[0].contents[0].parts[0].fileData.fileUri, "https://www.youtube.com/watch?v=abc");
  assert.equal(calls[0].config.temperature, 0);
});

test("transcribeYouTubeVideo: si el modelo se corta, continúa desde lo último transcrito y concatena", async () => {
  const { ai, calls } = fakeAi([
    { text: "[00:00] Voz 1: Primera parte de la charla.", finishReason: "MAX_TOKENS" },
    { text: `[10:00] Voz 1: Segunda parte y cierre.\n${END_MARKER}` },
  ]);
  const r = await transcribeYouTubeVideo({ ai, models: ["m1"] }, "https://youtu.be/abc");
  assert.equal(r.complete, true);
  assert.equal(r.passes, 2);
  assert.match(r.text, /Primera parte[\s\S]*Segunda parte/);
  const secondPrompt = calls[1].contents[0].parts[1].text as string;
  assert.ok(secondPrompt.includes("Primera parte de la charla."), "el prompt de continuación cita el final anterior");
});

test("transcribeYouTubeVideo: sin marca de fin se declara incompleta (no se da por buena)", async () => {
  const { ai } = fakeAi([{ text: "[00:00] Voz 1: Algo." }, { text: "" }]);
  const r = await transcribeYouTubeVideo({ ai, models: ["m1"] }, "https://youtu.be/abc");
  assert.equal(r.complete, false);
  assert.ok(r.note && /no confirmó el final/i.test(r.note));
});

test("transcribeYouTubeVideo: un modelo que se repite en la continuación se corta y se avisa", async () => {
  const bloque = "[00:00] Voz 1: Este es un párrafo suficientemente largo para detectar la repetición del modelo en la continuación del texto.";
  const { ai } = fakeAi([{ text: bloque, finishReason: "MAX_TOKENS" }, { text: bloque, finishReason: "MAX_TOKENS" }]);
  const r = await transcribeYouTubeVideo({ ai, models: ["m1"] }, "https://youtu.be/abc");
  assert.equal(r.complete, false);
  assert.ok(r.note && /repetirse/i.test(r.note));
  assert.equal(r.text, bloque, "no duplica el bloque repetido");
});

test("generateWithFallback: ante un 503 persistente en el primer modelo, pasa al siguiente", { timeout: 20_000 }, async () => {
  const seen: string[] = [];
  const ai: any = {
    models: {
      generateContent: async (req: any) => {
        seen.push(req.model);
        if (req.model === "m1") throw new Error("503 UNAVAILABLE high demand");
        return { text: `[00:00] ok\n${END_MARKER}`, candidates: [{ finishReason: "STOP" }] };
      },
    },
  };
  const r = await transcribeYouTubeVideo({ ai, models: ["m1", "m2"] }, "https://youtu.be/abc");
  assert.equal(r.model, "m2");
  assert.deepEqual(seen, ["m1", "m1", "m2"]);
});

test("transcribeImages: envía las imágenes como inlineData y devuelve el texto literal", async () => {
  const { ai, calls } = fakeAi([{ text: "TITULAR\n\nCuerpo [?]" }]);
  const r = await transcribeImages({ ai, models: ["m1"] }, [
    { mimeType: "image/jpeg", data: "AAAA" },
    { mimeType: "image/png", data: "BBBB" },
  ]);
  assert.equal(r.text, "TITULAR\n\nCuerpo [?]");
  const parts = calls[0].contents[0].parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0].inlineData.mimeType, "image/jpeg");
  assert.equal(parts[1].inlineData.data, "BBBB");
  assert.match(parts[2].text, /Imagen N/);
  assert.deepEqual(await transcribeImages({ ai, models: ["m1"] }, []), { text: "", model: "m1" });
});
