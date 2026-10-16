import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isBlockedIp, parseAndValidateUrl, safeFetch, UnsafeUrlError } from "../server/safeFetch";
import { validateAnalyzeBody, HttpError } from "../server/security";

test("isBlockedIp bloquea rangos internos y metadatos cloud", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00:ec2::254", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "not-an-ip"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("parseAndValidateUrl rechaza URLs peligrosas", () => {
  const bad = ["http://localhost/x", "http://localhost:3000", "http://127.0.0.1", "http://2130706433", "http://0x7f.0.0.1",
    "http://017700000001", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/",
    "file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "https://user:pass@example.com",
    "http://example.com:8080", "http://app.localhost", "", "x".repeat(3000), 42 as any, null as any];
  for (const u of bad) assert.throws(() => parseAndValidateUrl(u), UnsafeUrlError, String(u).slice(0, 40));
  assert.equal(parseAndValidateUrl("https://example.com/a?b=1").hostname, "example.com");
});

test("safeFetch rechaza loopback literal", async () => {
  await assert.rejects(() => safeFetch("http://127.0.0.1:80/"), UnsafeUrlError);
});

// Requiere que `evil.test` resuelva a 127.0.0.1 (echo "127.0.0.1 evil.test" >> /etc/hosts). Si no, se omite.
import dns from "node:dns";
const evilResolves = await new Promise<boolean>((ok) => dns.lookup("evil.test", (e, a) => ok(!e && a === "127.0.0.1")));
test("safeFetch bloquea un host público cuyo DNS apunta a loopback (rebinding)", { skip: !evilResolves }, async () => {
  const srv = http.createServer((_q, r) => r.end("SECRET")).listen(80, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  await assert.rejects(() => safeFetch("http://evil.test/"), UnsafeUrlError);
  srv.close();
});

test("validateAnalyzeBody aplica tipos, tamaños y tipos de fichero", () => {
  assert.doesNotThrow(() => validateAnalyzeBody({ url: "https://example.com", contentType: "blog" }));
  assert.throws(() => validateAnalyzeBody({ url: 5 }), HttpError);
  assert.throws(() => validateAnalyzeBody({ manualText: "x".repeat(200_001) }), HttpError);
  assert.throws(() => validateAnalyzeBody({ contentType: "hack" }), HttpError);
  assert.throws(() => validateAnalyzeBody({ files: [{ name: "a.exe", data: "data:application/x-msdownload;base64,AAAA" }] }), HttpError);
  const big = "data:application/pdf;base64," + "A".repeat(11 * 1024 * 1024 * 4 / 3);
  assert.throws(() => validateAnalyzeBody({ files: [{ name: "a.pdf", data: big }] }), HttpError);
  const small = { name: "a.pdf", data: "data:application/pdf;base64,AAAA" };
  assert.throws(() => validateAnalyzeBody({ files: Array(6).fill(small) }), HttpError);
});
