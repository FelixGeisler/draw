import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import webPush from "web-push";
import { createApp } from "../../src/app.js";
import { AUTHORITY_FILE, PushLifecycle } from "../../src/push/authority.js";
import { PushAdmission } from "../../src/push/admission.js";
import { PushService } from "../../src/push/service.js";
import { invalidNoBodyFraming } from "../../src/routes/push.js";
import type { IsolatedResolver, ResolverFactory } from "../../src/push/resolver.js";
import { normalizeIp } from "../../src/push/topology.js";
import { testDb } from "../helpers.js";

const roots: string[] = [];
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const keys = webPush.generateVAPIDKeys();
const payload = (endpoint = "https://push.example/sub") => ({
  subscription: { endpoint, expirationTime: null, keys: { p256dh: keys.publicKey, auth: crypto.randomBytes(16).toString("base64url") } },
});
const resolver = (): IsolatedResolver => ({
  resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); }, cancel() {},
});

describe("Push registration HTTP API", () => {
  let database: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    database = await testDb();
    database.prepare("DELETE FROM push_subscriptions").run();
    database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
  });

  function service(
    trustProxy: boolean | number | string = false,
    listenerPort = 1234,
    resolverFactory: ResolverFactory = resolver,
    overrides: Partial<ConstructorParameters<typeof PushService>[0]> = {},
  ) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-api-"));
    roots.push(dataDir);
    const lifecycle = new PushLifecycle({
      dataDir,
      deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
    });
    return new PushService({
      database, lifecycle, resolverFactory,
      topology: { listenerHost: "127.0.0.1", listenerPort, trustProxy },
      wallNow: () => Date.parse("2026-09-19T12:00:00Z"),
      ...overrides,
    });
  }

  const direct = <T extends request.Test>(value: T): T => value
    .set("Host", "localhost:1234")
    .set("Origin", "http://localhost:1234")
    .set("Sec-Fetch-Site", "same-origin") as T;

  it("returns the exact originless status projection and exact four mutation results", async () => {
    const push = service();
    const app = createApp({}, { push });
    const initial = await request(app).get("/api/push/status").set("Host", "localhost:1234");
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      available: true, reason: null, mutationAllowed: true, mutationReason: null,
      vapidPublicKey: push.snapshot().publicVapidKey, maxDevices: 16,
      preferences: { hideDetails: false }, devices: [],
    });

    const created = await direct(request(app).post("/api/push/subscriptions")).send(payload());
    expect(created.status).toBe(201);
    expect(created.body.device.id).toMatch(/^[0-9a-f-]{36}$/);
    const updated = await direct(request(app).post("/api/push/subscriptions")).send(payload());
    expect(updated.status).toBe(200);
    expect(updated.body.device.id).toBe(created.body.device.id);
    const preference = await direct(request(app).put("/api/push/preferences")).send({ hideDetails: true });
    expect(preference.status).toBe(200);
    expect(preference.body).toEqual({ hideDetails: true });
    expect((await direct(request(app).delete(`/api/push/subscriptions/${created.body.device.id}`))).status).toBe(204);
    expect((await direct(request(app).delete("/api/push/subscriptions"))).status).toBe(204);
  });

  it("rejects every no-body framing variant before route work", async () => {
    expect(invalidNoBodyFraming([])).toBe(false);
    expect(invalidNoBodyFraming(["Content-Length", "0"])).toBe(false);
    for (const rawHeaders of [
      ["Transfer-Encoding", "chunked"],
      ["Content-Length", "0", "Content-Length", "0"],
      ["Content-Length", "not-decimal"],
      ["Content-Length", "1"],
    ]) expect(invalidNoBodyFraming(rawHeaders), rawHeaders.join(":")).toBe(true);

    let resolutions = 0;
    let sends = 0;
    const endpoint = "https://push.example/test";
    const push = service(false, 1234, () => ({
      resolve4: async () => { resolutions += 1; return ["8.8.8.8"]; },
      resolve6: async () => { resolutions += 1; throw Object.assign(new Error("none"), { code: "ENODATA" }); },
      cancel() {},
    }), {
      generateRequestDetails: () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") }),
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const app = createApp({}, { push });
    const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(missingId, endpoint, keys.publicKey, crypto.randomBytes(16).toString("base64url"), "a", "b");
    const nonzero = await direct(request(app).post(`/api/push/subscriptions/${missingId}/test`)
      .set("Content-Length", "1").send("x"));
    expect(nonzero).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    const chunked = await direct(request(app).post(`/api/push/subscriptions/${missingId}/test`)
      .set("Transfer-Encoding", "chunked").send(""));
    expect(chunked).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    expect({ resolutions, sends }).toEqual({ resolutions: 0, sends: 0 });
  });

  it("serves exact manual-test outcomes and precedence without leaking provider detail", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://push.example/test";
    const push = service(false, 1234, resolver, {
      generateRequestDetails: () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") }),
      transport: { send: async () => "success" },
    });
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, endpoint, keys.publicKey, crypto.randomBytes(16).toString("base64url"), "a", "b");
    const app = createApp({}, { push });
    const success = await direct(request(app).post(`/api/push/subscriptions/${deviceId}/test`));
    expect(success.status).toBe(204);
    expect(success.text).toBe("");

    const limited = await direct(request(app).post(`/api/push/subscriptions/${deviceId}/test`));
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "push-rate-limited" });
    expect(limited.headers["retry-after"]).toBe("10");
    expect(Object.keys(limited.body)).toEqual(["error"]);

    expect(await direct(request(app).post("/api/push/subscriptions/not-a-uuid/test")))
      .toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    expect(await request(app).post("/api/push/subscriptions/not-a-uuid/test")
      .set("Host", "evil.example").set("Origin", "http://evil.example"))
      .toMatchObject({ status: 403, body: { error: "push-mutation-forbidden" } });
    expect(await direct(request(app).post(`/api/push/subscriptions/${deviceId}/test`).set("Content-Length", "1").send("x")))
      .toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    expect(JSON.stringify(limited.body)).not.toContain("push.example");
  });

  it("serves the complete closed manual-test HTTP matrix", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://push.example/private/path?provider-secret=1";
    const matrixAuth = crypto.randomBytes(16).toString("base64url");
    const insert = (values: { endpoint?: string; expiration?: number | null } = {}) => database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, values.endpoint ?? endpoint, keys.publicKey, matrixAuth,
      values.expiration ?? null, "private-created", "private-seen");
    const invoke = async (push: PushService) => direct(
      request(createApp({}, { push })).post(`/api/push/subscriptions/${deviceId}/test`),
    );
    const assertClosed = (response: request.Response, status: number, error: string) => {
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      expect(response.body).toEqual({ error });
      const text = JSON.stringify(response.body);
      for (const value of [
        "push.example", "/private/path", "provider-secret", "8.8.8.8", keys.publicKey, matrixAuth,
        "private-created", "private-seen", "encrypted", "authorization", "raw exception",
      ]) expect(text).not.toContain(value);
    };

    assertClosed(await invoke(service()), 404, "push-device-not-found");

    const expired = service();
    insert({ expiration: Date.parse("2026-09-19T12:00:00Z") });
    assertClosed(await invoke(expired), 410, "push-subscription-gone");
    expect(database.prepare("SELECT id FROM push_subscriptions").get()).toBeUndefined();

    const corrupt = service();
    insert({ endpoint: "http://corrupt.invalid/private" });
    assertClosed(await invoke(corrupt), 502, "push-delivery-failed");
    database.prepare("DELETE FROM push_subscriptions").run();

    const recovery = service();
    insert();
    recovery.invalidate();
    assertClosed(await invoke(recovery), 503, "push-recovery-pending");
    database.prepare("DELETE FROM push_subscriptions").run();

    const unavailableDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-unavailable-"));
    roots.push(unavailableDir);
    fs.writeFileSync(path.join(unavailableDir, AUTHORITY_FILE), "{not-json");
    const unavailableLifecycle = new PushLifecycle({
      dataDir: unavailableDir,
      deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
    });
    const unavailable = new PushService({
      database, lifecycle: unavailableLifecycle, resolverFactory: resolver,
      topology: { listenerHost: "127.0.0.1", listenerPort: 1234, trustProxy: false },
    });
    assertClosed(await invoke(unavailable), 503, "push-unavailable");

    const busy = service(false, 1234, resolver, { admission: new PushAdmission(() => 0, { active: 4 }) });
    insert();
    assertClosed(await invoke(busy), 503, "push-busy");
    database.prepare("DELETE FROM push_subscriptions").run();

    let cancellation!: PushService;
    cancellation = service(false, 1234, () => ({
      resolve4: async () => ["8.8.8.8"],
      resolve6: async () => {
        database.prepare("UPDATE push_subscriptions SET last_seen_at='changed' WHERE id=?").run(deviceId);
        throw Object.assign(new Error("none"), { code: "ENODATA" });
      },
      cancel() {},
    }), { transport: { send: async () => "success" } });
    insert();
    assertClosed(await invoke(cancellation), 409, "push-test-cancelled");
    database.prepare("DELETE FROM push_subscriptions").run();

    for (const [outcome, status, error] of [
      ["success", 204, null],
      ["gone", 410, "push-subscription-gone"],
      ["failed", 502, "push-delivery-failed"],
      ["timeout", 504, "push-timeout"],
    ] as const) {
      database.prepare("DELETE FROM push_subscriptions").run();
      const push = service(false, 1234, resolver, {
        generateRequestDetails: () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") }),
        transport: { send: async () => outcome },
      });
      insert();
      const response = await invoke(push);
      if (status === 204) {
        expect(response.status).toBe(204);
        expect(response.text).toBe("");
      } else assertClosed(response, status, error!);
    }
  });

  it("keeps the whole namespace auth-first, while login/non-Push retain general parser behavior", async () => {
    const password = "owner-secret";
    const push = service();
    const app = createApp({ password }, { push });
    const unauthenticated = [
      request(app).post("/api/push/subscriptions").set("Content-Type", "application/json").send("{"),
      request(app).post("/api/push/subscriptions").set("Content-Type", "text/plain").send("x"),
      request(app).post("/api/push/subscriptions").set("Content-Type", "application/json").set("Content-Encoding", "gzip").send("x"),
      request(app).post("/api/push/subscriptions").set("Content-Type", "application/json").send("x".repeat(8193)),
      request(app).get("/api/push/status").set("Content-Length", "1").send("x"),
      request(app).post("/api/push/subscriptions/not-a-uuid/test").set("Content-Length", "1").send("x"),
    ];
    for (const call of unauthenticated) {
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "authentication required" });
    }

    const malformed = await direct(request(app).post("/api/push/subscriptions"))
      .set("x-draw-password", password).set("Content-Type", "application/json").send("{");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid-push-request" });
    const media = await direct(request(app).post("/api/push/subscriptions"))
      .set("x-draw-password", password).set("Content-Type", "text/plain").send("x");
    expect(media.status).toBe(415);
    expect(media.body).toEqual({ error: "push-json-required" });
    const encoded = await direct(request(app).post("/api/push/subscriptions"))
      .set("x-draw-password", password).set("Content-Type", "application/json").set("Content-Encoding", "gzip").send("x");
    expect(encoded.status).toBe(415);
    const exactBody = JSON.stringify({ x: "x".repeat(8_184) });
    expect(Buffer.byteLength(exactBody)).toBe(8_192);
    const exact = await direct(request(app).post("/api/push/subscriptions"))
      .set("x-draw-password", password).set("Content-Type", "application/json").send(exactBody);
    expect(exact.status).toBe(400); // parser admitted exactly 8,192; finite shape rejected it
    const oversized = await direct(request(app).post("/api/push/subscriptions"))
      .set("x-draw-password", password).set("Content-Type", "application/json").send(`${exactBody} `);
    expect(oversized.status).toBe(413);
    const framed = await request(app).get("/api/push/status").set("x-draw-password", password).set("Content-Length", "1").send("x");
    expect(framed.status).toBe(400);

    const login = await request(app).post("/api/auth/login").send({ password });
    expect(login.status).toBe(204);
    const cookieMalformed = await direct(request(app).post("/api/push/subscriptions"))
      .set("Cookie", login.headers["set-cookie"][0].split(";")[0])
      .set("Content-Type", "application/json").send("{");
    expect(cookieMalformed).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    const nonPushMalformed = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{");
    expect(nonPushMalformed.status).toBe(400);
    expect(nonPushMalformed.headers["content-type"]).toContain("text/html");
  });

  it("enforces direct-loopback Host/origin/rebinding/cross-site rules with and without a password", async () => {
    for (const password of [undefined, "secret"]) {
      const app = createApp({ ...(password ? { password } : {}) }, { push: service() });
      const credential = (test: request.Test) => password ? test.set("x-draw-password", password) : test;
      for (const host of ["localhost:1234", "127.0.0.1:1234", "[::1]:1234"]) {
        const response = await credential(request(app).put("/api/push/preferences"))
          .set("Host", host).set("Origin", `http://${host}`).send({ hideDetails: false });
        expect(response.status, host).toBe(200);
      }
      for (const [host, origin, site] of [
        ["attacker.example:1234", "http://attacker.example:1234", "same-origin"],
        ["localhost", "http://localhost", "same-origin"],
        ["localhost:1234", "https://localhost:1234", "same-origin"],
        ["localhost:1234", "http://evil.example:1234", "same-origin"],
        ["localhost:1234", "http://localhost:1234", "cross-site"],
      ]) {
        const response = await credential(request(app).put("/api/push/preferences"))
          .set("Host", host).set("Origin", origin).set("Sec-Fetch-Site", site).send({ hideDetails: false });
        expect(response.status, `${host} ${origin}`).toBe(403);
        expect(response.body).toEqual({ error: "push-mutation-forbidden" });
      }
    }

    const trusted = createApp({ trustProxy: 1 }, { push: service(1) });
    const trustedStatus = await request(trusted).get("/api/push/status").set("Host", "localhost:1234");
    expect(trustedStatus.body).toMatchObject({ mutationAllowed: false, mutationReason: "secure-transport-required" });
    expect((await request(trusted).put("/api/push/preferences")
      .set("Host", "localhost:1234").set("Origin", "http://localhost:1234")
      .send({ hideDetails: false })).status).toBe(403);

    const defaultPort = createApp({}, { push: service(false, 80) });
    const omittedPort = await request(defaultPort).put("/api/push/preferences")
      .set("Host", "localhost").set("Origin", "http://localhost:80").send({ hideDetails: false });
    expect(omittedPort).toMatchObject({ status: 403, body: { error: "push-mutation-forbidden" } });
  });

  it("normalizes every IPv4-mapped IPv6 spelling to one client admission bucket", async () => {
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("::ffff:c000:201")).toBe("192.0.2.1");
    expect(normalizeIp("::ffff:7f00:1")).toBe("127.0.0.1");

    const app = createApp({ trustProxy: 1 }, { push: service(1) });
    const register = (client: string, index: number) => request(app).post("/api/push/subscriptions")
      .set("Host", "draw.example").set("Origin", "https://draw.example")
      .set("X-Forwarded-For", client).set("X-Forwarded-Proto", "https")
      .send(payload(`https://push${index}.example/sub`));
    for (let index = 0; index < 4; index++) {
      const client = index % 2 === 0 ? "::ffff:192.0.2.1" : "::ffff:c000:201";
      expect((await register(client, index)).status).toBe(201);
    }
    const limited = await register("::ffff:c000:201", 4);
    expect(limited).toMatchObject({ status: 429, body: { error: "push-rate-limited" } });
  });

  it("accepts strict Tailscale/Nginx forwarded HTTPS and rejects missing, unknown, conflicting, or malformed forwarding", async () => {
    const app = createApp({ trustProxy: 1 }, { push: service(1) });
    const secure = () => request(app).put("/api/push/preferences")
      .set("Host", "draw.example")
      .set("Origin", "https://draw.example")
      .set("X-Forwarded-For", "100.100.100.7")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "draw.example")
      .send({ hideDetails: false });
    expect((await secure()).status).toBe(200);
    expect((await request(app).put("/api/push/preferences")
      .set("Host", "draw.example").set("Origin", "https://draw.example")
      .set("X-Forwarded-For", "100.100.100.7").set("X-Forwarded-Proto", "https")
      .send({ hideDetails: false })).status).toBe(200); // forwarded Host is optional
    expect((await secure().set("X-Real-IP", "10.0.0.8")).status).toBe(200);
    expect((await secure().set("X-Forwarded-Unknown", "value")).status).toBe(403);
    expect((await secure().set("X-Forwarded-Port", "443")).status).toBe(403);
    expect((await secure().set("Forwarded", "for=100.100.100.7;proto=https")).status).toBe(403);
    expect((await secure().set("X-Forwarded-Host", "other.example")).status).toBe(403);
    expect((await request(app).put("/api/push/preferences")
      .set("Host", "draw.example").set("Origin", "https://draw.example")
      .set("X-Forwarded-Proto", "https").send({ hideDetails: false })).status).toBe(403);

    const status = await request(app).get("/api/push/status")
      .set("Host", "draw.example").set("Origin", "https://evil.example").set("Sec-Fetch-Site", "cross-site")
      .set("X-Forwarded-For", "100.100.100.7").set("X-Forwarded-Proto", "https");
    expect(status.body.mutationAllowed).toBe(true); // originless status ignores mutation headers

    const loopback = createApp({ trustProxy: "loopback" }, { push: service("loopback") });
    const bareMetal = await request(loopback).put("/api/push/preferences")
      .set("Host", "draw.example").set("Origin", "https://draw.example")
      .set("X-Forwarded-For", "100.100.100.9").set("X-Forwarded-Proto", "https")
      .send({ hideDetails: false });
    expect(bareMetal.status).toBe(200);
  });
});
