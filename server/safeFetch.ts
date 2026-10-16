// Fase 0 · Anti-SSRF. Todas las peticiones salientes a URLs que aporta el usuario pasan por aquí.
// Defensa en capas: (1) validación sintáctica, (2) validación de la IP en el MOMENTO de conectar
// (cierra DNS-rebinding), (3) redirecciones manuales revalidadas, (4) timeout y tope de bytes.
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** true si la IP no es un destino público enrutable (loopback, privada, link-local, metadatos cloud, CGNAT, etc.). */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // no es una IP válida → bloquear por defecto

  if (family === 6) {
    const v6 = ip.toLowerCase();
    // IPv4 mapeada (::ffff:a.b.c.d o ::ffff:7f00:1) → evaluar como IPv4
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 ULA (incluye fd00:ec2::254, metadatos AWS)
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
    if (/^ff/.test(v6)) return true; // multicast
    if (v6.startsWith("64:ff9b:")) return true; // NAT64: puede encapsular IPv4 interna
    if (v6.startsWith("2001:db8:")) return true; // documentación
    return false;
  }

  const [a, b] = ip.split(".").map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // privada
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + metadatos cloud 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 y 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reservado + broadcast
  return false;
}

/** Validación sintáctica. Lanza UnsafeUrlError si no es aceptable. Devuelve la URL parseada. */
export function parseAndValidateUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new UnsafeUrlError("La URL no es válida (tipo o longitud).");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("La URL no es válida.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError("Solo se admiten URLs http o https.");
  }
  if (u.username || u.password) {
    throw new UnsafeUrlError("No se admiten credenciales dentro de la URL.");
  }
  if (!ALLOWED_PORTS.has(u.port)) {
    throw new UnsafeUrlError("Solo se admiten los puertos 80 y 443.");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("Host no permitido.");
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new UnsafeUrlError("La dirección IP de destino no está permitida.");
  }
  return u;
}

// lookup que se ejecuta al conectar: valida cada IP resuelta (y la conexión usa exactamente ese resultado).
const guardedLookup: any = (hostname: string, options: any, callback: any) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options || {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses: any) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        return cb(new UnsafeUrlError("El host resuelve a una dirección no permitida."));
      }
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
};

const agent = new Agent({
  connect: { lookup: guardedLookup },
  headersTimeout: 15_000,
  bodyTimeout: 20_000,
});

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  finalUrl: string;
  contentType: string;
  text: () => Promise<string>;
  json: () => Promise<any>;
}

async function readCapped(res: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`La respuesta supera el límite de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** fetch seguro (GET) para URLs controladas por el usuario. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const { headers = {}, timeoutMs = 15_000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5 } = opts;
  let current = parseAndValidateUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await undiciFetch(current.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e: any) => {
      // undici envuelve el error del lookup en "fetch failed"; recuperar la causa si es nuestra.
      if (e?.cause instanceof UnsafeUrlError) throw e.cause;
      throw e;
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      current = parseAndValidateUrl(new URL(res.headers.get("location")!, current).toString());
      continue;
    }

    let cached: string | undefined;
    const readOnce = async () => (cached ??= await readCapped(res, maxBytes));
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText,
      finalUrl: current.toString(),
      contentType: res.headers.get("content-type") || "",
      text: readOnce,
      json: async () => JSON.parse(await readOnce()),
    };
  }
  throw new UnsafeUrlError("Demasiadas redirecciones.");
}
