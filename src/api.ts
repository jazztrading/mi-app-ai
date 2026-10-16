// Fase 0 · Cliente de API con credencial. No se usa VITE_*: cualquier variable VITE_ acaba en el
// bundle público. La clave se pide en tiempo de ejecución y se guarda solo en esta pestaña.
const KEY = "lupa_access_token";
// ASCII imprimible sin espacios, mínimo 16: es lo único que admiten con seguridad las cabeceras HTTP.
const VALID = /^[\x21-\x7E]{16,}$/;

const getToken = () => {
  try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
};
const clearToken = () => {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
};

function askToken(message = "Clave de acceso de Lupa Crítica:"): string {
  for (;;) {
    const raw = window.prompt(message);
    if (raw === null) return ""; // el usuario canceló
    const t = raw.trim();
    if (VALID.test(t)) {
      try { sessionStorage.setItem(KEY, t); } catch { /* ignore */ }
      return t;
    }
    message =
      "La clave solo puede llevar letras, números y símbolos ASCII (sin espacios, acentos ni comillas o rayas tipográficas) y tener 16 caracteres o más. Escríbela de nuevo:";
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  let token = getToken();
  if (token && !VALID.test(token)) { clearToken(); token = ""; } // descarta una clave guardada que ya era inválida
  if (!token) token = askToken();
  let res = await send(token);
  if (res.status === 401) {
    clearToken();
    token = askToken("Clave incorrecta. Vuelve a escribirla:");
    if (token) res = await send(token);
  }
  return res;
}
