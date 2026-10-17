import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAuth, dailyCostlyCap, _resetDailyCapForTests } from "../server/security";

const mkRes = () => {
  const r: any = { code: 200, body: null };
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: any) => ((r.body = b), r);
  return r;
};
const mkReq = (auth?: string): any => ({ get: (h: string) => (h.toLowerCase() === "authorization" ? auth : undefined) });

test("por defecto la clave es obligatoria (falla cerrado sin APP_ACCESS_TOKEN)", () => {
  delete process.env.REQUIRE_AUTH;
  delete process.env.APP_ACCESS_TOKEN;
  const res = mkRes(); let passed = false;
  requireAuth(mkReq(), res, () => (passed = true));
  assert.equal(passed, false);
  assert.equal(res.code, 503);
});

test("REQUIRE_AUTH=false deja pasar sin credencial; cualquier otro valor la sigue exigiendo", () => {
  process.env.REQUIRE_AUTH = "false";
  let passed = false;
  requireAuth(mkReq(), mkRes(), () => (passed = true));
  assert.equal(passed, true);
  for (const v of ["true", "0", "FALSE", "no", ""]) {
    process.env.REQUIRE_AUTH = v; process.env.APP_ACCESS_TOKEN = "x".repeat(20);
    const res = mkRes(); let p2 = false;
    requireAuth(mkReq(), res, () => (p2 = true));
    assert.equal(p2, false, `valor ${JSON.stringify(v)} no debe abrir la API`);
    assert.equal(res.code, 401);
  }
  delete process.env.REQUIRE_AUTH; delete process.env.APP_ACCESS_TOKEN;
});

test("el tope diario global corta en el límite, sin importar la IP", () => {
  process.env.DAILY_COSTLY_MAX = "3";
  _resetDailyCapForTests();
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = mkRes(); let ok = false;
    dailyCostlyCap({ ip: "9.9.9." + i } as any, res, () => (ok = true));
    codes.push(ok ? 200 : res.code);
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  delete process.env.DAILY_COSTLY_MAX;
});
