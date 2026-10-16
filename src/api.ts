// Fase 0 · Cliente de API con credencial. No se usa VITE_*: cualquier variable VITE_ acaba en el
// bundle público. La clave se pide en tiempo de ejecución y se guarda solo en esta pestaña.
const KEY = "lupa_access_token";

function getToken(): string {
  try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
}
function askToken(): string {
  const t = (window.prompt("Clave de acceso de Lupa Crítica:") || "").trim();
  try { if (t) sessionStorage.setItem(KEY, t); } catch { /* ignore */ }
  return t;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  let token = getToken() || askToken();
  let res = await send(token);
  if (res.status === 401) {
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    token = askToken();
    if (token) res = await send(token);
  }
  return res;
}
