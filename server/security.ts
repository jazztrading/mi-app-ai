// Fase 0 · Autenticación, rate limit, validación de entradas y cabeceras de seguridad.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const intEnv = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// ── Límites (todos ajustables por variable de entorno) ───────────────────────
export const MAX_BODY_MB = intEnv("MAX_BODY_MB", 12); // cuerpo JSON total (los ficheros viajan en base64, +33 %)
export const MAX_FILE_MB = intEnv("MAX_FILE_MB", 8); // tamaño decodificado por fichero
export const MAX_FILES = intEnv("MAX_FILES", 5);
export const MAX_TEXT_CHARS = intEnv("MAX_TEXT_CHARS", 200_000);

// ── Autenticación por token compartido ───────────────────────────────────────
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

/** REQUIRE_AUTH=false (sin distinguir mayúsculas ni espacios) desactiva la clave. Cualquier otro valor o su ausencia: exigida. */
export const isAuthRequired = () => (process.env.REQUIRE_AUTH ?? "").trim().toLowerCase() !== "false";

/** Falla cerrado: si la clave es obligatoria y APP_ACCESS_TOKEN no está definido, la API protegida responde 503. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthRequired()) return next();
  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected || expected.length < 16) {
    return res.status(503).json({ error: "Servidor sin credencial configurada (APP_ACCESS_TOKEN, mínimo 16 caracteres)." });
  }
  const header = req.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // comparación en tiempo constante sobre hashes de longitud fija
  const ok = provided.length > 0 && crypto.timingSafeEqual(sha256(provided), sha256(expected));
  if (!ok) return res.status(401).json({ error: "No tienes permiso: falta la clave de acceso o es incorrecta." });
  next();
}

// ── Rate limiting ────────────────────────────────────────────────────────────
const common = { standardHeaders: "draft-8" as const, legacyHeaders: false };

/** Frena fuerza bruta: solo cuentan los 401 (credencial ausente o incorrecta); un 400 de validación no penaliza. */
export const failedAuthLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: intEnv("RL_FAILED_AUTH_MAX", 20),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
  message: { error: "Has fallado demasiadas veces. Espera 15 minutos." },
});

export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: intEnv("RL_API_MAX", 300),
  message: { error: "Demasiadas peticiones. Inténtalo más tarde." },
});

/** Rutas que gastan cuota de Gemini u OpenAlex/Crossref. */
export const costlyLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: intEnv("RL_COSTLY_MAX", 15),
  message: { error: "Has llegado al máximo de análisis por hora. Inténtalo más tarde." },
});

/**
 * Tope GLOBAL diario (todas las IP juntas) de operaciones que gastan cuota de Gemini. Es la red de seguridad cuando
 * no hay clave: limita el gasto máximo aunque el atacante cambie de IP. Se guarda en memoria, así que se reinicia
 * si el servidor se reinicia; el tope mensual de Google AI Studio sigue siendo la protección real.
 */
let capDay = "";
let capCount = 0;
export const dailyCostlyMax = () => intEnv("DAILY_COSTLY_MAX", 60);
export function dailyCostlyCap(_req: Request, res: Response, next: NextFunction) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) {
    capDay = today;
    capCount = 0;
  }
  if (capCount >= dailyCostlyMax()) {
    return res.status(429).json({ error: `Se ha llegado al máximo de análisis de hoy (${dailyCostlyMax()}). Inténtalo mañana.` });
  }
  capCount++;
  next();
}
export function _resetDailyCapForTests() {
  capDay = "";
  capCount = 0;
}

// ── Cabeceras de seguridad mínimas (sin dependencia extra) ───────────────────
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store"); // las respuestas de /api contienen contenido del usuario
  next();
}

// ── Validación de entradas ───────────────────────────────────────────────────
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CONTENT_TYPES = new Set(["blog", "podcast", "youtube", "manual", "photo", "document"]);
const ALLOWED_MIME = [/^application\/pdf$/, /^application\/msword$/, /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/, /^image\/(jpeg|png|webp|gif)$/];
const ALLOWED_EXT = /\.(pdf|docx?|jpe?g|png|webp|gif)$/i;

function checkDataString(data: unknown, name?: string, type?: string) {
  if (typeof data !== "string" || data.length === 0) throw new HttpError(400, "Archivo no válido.");
  const m = data.match(/^data:([^;,]+)[^,]*;base64,/);
  const mime = (m ? m[1] : type || "").toLowerCase();
  const mimeOk = ALLOWED_MIME.some((re) => re.test(mime));
  const extOk = typeof name === "string" && ALLOWED_EXT.test(name);
  if (!mimeOk && !extOk) throw new HttpError(400, "Ese tipo de archivo no se admite. Sube un PDF, un Word o una imagen.");
  const approxBytes = Math.floor((data.length * 3) / 4);
  if (approxBytes > MAX_FILE_MB * 1024 * 1024) throw new HttpError(400, `Un archivo pesa más de ${MAX_FILE_MB} MB.`);
}

/** Valida el cuerpo de POST /api/analyze. Lanza HttpError(400) si algo no cuadra. */
export function validateAnalyzeBody(body: any): void {
  if (!body || typeof body !== "object") throw new HttpError(400, "Cuerpo de petición no válido.");
  const { url, manualText, contentType, images, image, files } = body;
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") throw new HttpError(400, "`fresh` debe ser booleano.");
  if (body.previous !== undefined && body.previous !== null && (typeof body.previous !== "object" || Array.isArray(body.previous))) {
    throw new HttpError(400, "`previous` debe ser un objeto.");
  }
  if (url !== undefined && url !== null && url !== "" && (typeof url !== "string" || url.length > 2048)) {
    throw new HttpError(400, "La URL no es válida (tipo o longitud).");
  }
  if (manualText !== undefined && manualText !== null) {
    if (typeof manualText !== "string") throw new HttpError(400, "El texto manual debe ser una cadena.");
    if (manualText.length > MAX_TEXT_CHARS) throw new HttpError(400, `El texto es demasiado largo (máximo ${MAX_TEXT_CHARS} caracteres).`);
  }
  if (contentType !== undefined && contentType !== null && !CONTENT_TYPES.has(contentType)) {
    throw new HttpError(400, "Tipo de contenido no válido.");
  }
  let count = 0;
  if (files !== undefined) {
    if (!Array.isArray(files)) throw new HttpError(400, "`files` debe ser una lista.");
    for (const f of files) {
      if (typeof f === "string") checkDataString(f);
      else if (f && typeof f === "object") checkDataString(f.data, f.name, f.type);
      else throw new HttpError(400, "Archivo no válido.");
      count++;
    }
  }
  if (images !== undefined) {
    if (!Array.isArray(images)) throw new HttpError(400, "`images` debe ser una lista.");
    for (const img of images) {
      checkDataString(img, undefined, "image/jpeg");
      count++;
    }
  }
  if (image !== undefined && image !== null && image !== "") {
    checkDataString(image, undefined, "image/jpeg");
    count++;
  }
  if (count > MAX_FILES) throw new HttpError(400, `Máximo ${MAX_FILES} archivos por análisis.`);
}
