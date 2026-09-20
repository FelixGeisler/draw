import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import { testDb } from "../helpers.js";
import { PushLifecycle, REVOKE_MARKER } from "../../src/push/authority.js";
import { PushAdmission } from "../../src/push/admission.js";
import { PushApiError, PushService, validateRegistration } from "../../src/push/service.js";
import type { IsolatedResolver } from "../../src/push/resolver.js";
import type { PushTransport, PushTransportResult } from "../../src/push/transport.js";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-service-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

const keys = webPush.generateVAPIDKeys();
const auth = crypto.randomBytes(16).toString("base64url");
const registration = (endpoint: string, replaceDeviceId?: string) => ({
  subscription: { endpoint, expirationTime: null, keys: { p256dh: keys.publicKey, auth } },
  ...(replaceDeviceId ? { replaceDeviceId } : {}),
});

const successfulResolver = (): IsolatedResolver => ({
  resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); }, cancel: () => {},
});

describe("Push registration service", () => {
  let database: Awaited<ReturnType<typeof testDb>>;
  let lifecycle: PushLifecycle;
  beforeEach(async () => {
    database = await testDb();
    database.prepare("DELETE FROM push_subscriptions").run();
    database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
    lifecycle = new PushLifecycle({
      dataDir: root(),
      deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
    });
  });

  const make = (overrides: Partial<ConstructorParameters<typeof PushService>[0]> = {}) => {
    return new PushService({
      database, lifecycle, topology: { listenerHost: "127.0.0.1", listenerPort: 1234, trustProxy: false },
      resolverFactory: successfulResolver, wallNow: () => Date.parse("2026-09-19T12:00:00.000Z"),
      ...overrides,
    });
  };

  it("validates the exact finite subscription shape and expiry boundary", () => {
    const now = 1_000;
    expect(validateRegistration(registration("https://push.example/path?q=1"), now).endpoint).toBe("https://push.example/path?q=1");
    for (const value of [
      null, [], {},
      { ...registration("http://push.example"), extra: true },
      registration("https://127.0.0.1/push"),
      registration("https://push.example:444/push"),
      { subscription: { ...registration("https://push.example").subscription, expirationTime: now } },
      { subscription: { ...registration("https://push.example").subscription, keys: { p256dh: "x", auth } } },
    ]) expect(() => validateRegistration(value, now)).toThrow(PushApiError);
  });

  it("rejects canonical port, credential, and fragment syntax after WHATWG preprocessing", () => {
    const now = 1_000;
    for (let codePoint = 0; codePoint <= 0x20; codePoint++) {
      const prefix = String.fromCharCode(codePoint);
      expect(
        () => validateRegistration(registration(`${prefix}https://push.example:8443/path`), now),
        `leading U+${codePoint.toString(16).padStart(4, "0")}`,
      ).toThrow(PushApiError);
    }

    const prefixes = ["", "\u0000 ", "\t\r\n"];
    const schemes = ["https:", "hTtPs:", "h\tt\r\nPs:"];
    const authoritySeparators = ["//", "/", "", "\\", "/\\", "////", "/\t/\r\n"];
    for (const prefix of prefixes) {
      for (const scheme of schemes) {
        for (const separator of authoritySeparators) {
          const portEndpoint = `${prefix}${scheme}${separator}push.example:8443/path`;
          expect(() => new URL(portEndpoint), JSON.stringify(portEndpoint)).not.toThrow();
          expect(() => validateRegistration(registration(portEndpoint), now), JSON.stringify(portEndpoint)).toThrow(PushApiError);

          for (const userinfo of ["@", ":@", "user@", ":secret@", "user:secret@"]) {
            const credentialEndpoint = `${prefix}${scheme}${separator}${userinfo}push.example/path`;
            expect(() => new URL(credentialEndpoint), JSON.stringify(credentialEndpoint)).not.toThrow();
            expect(() => validateRegistration(registration(credentialEndpoint), now), JSON.stringify(credentialEndpoint)).toThrow(PushApiError);
          }

          for (const fragment of ["#", "#topic"]) {
            const fragmentEndpoint = `${prefix}${scheme}${separator}push.example/path${fragment}`;
            expect(() => new URL(fragmentEndpoint), JSON.stringify(fragmentEndpoint)).not.toThrow();
            expect(() => validateRegistration(registration(fragmentEndpoint), now), JSON.stringify(fragmentEndpoint)).toThrow(PushApiError);
          }
        }
      }
    }

    for (const [input, normalized] of [
      ["https://push.example/path", "https://push.example/path"],
      ["\t\nhttps://push.example:443/path", "https://push.example/path"],
      ["https://push.example/device%40id?topic=%23alerts", "https://push.example/device%40id?topic=%23alerts"],
      ["https://push.example/path?contact=user%40example.test&marker=%23safe", "https://push.example/path?contact=user%40example.test&marker=%23safe"],
    ]) {
      expect(validateRegistration(registration(input), now).endpoint).toBe(normalized);
    }
  });

  it("upserts the same endpoint, rotates to a new id on replacement, ignores stale replacement, and redacts ordered status", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    let index = 0;
    const service = make({ randomUUID: () => ids[index++] });
    const first = await service.register(registration("https://push.example/a"), "client-a");
    expect(first).toMatchObject({ created: true, device: { id: ids[0] } });
    const same = await service.register(registration("https://push.example/a"), "client-a");
    expect(same).toMatchObject({ created: false, device: { id: ids[0], createdAt: first.device.createdAt } });
    const replaced = await service.register(registration("https://push.example/b", ids[0]), "client-b");
    expect(replaced.device.id).toBe(ids[1]);
    const stale = await service.register(registration("https://push.example/c", ids[0]), "client-c");
    expect(stale.device.id).toBe(ids[2]);

    const status = service.status();
    expect(status.devices.map((device) => device.id)).toEqual([ids[1], ids[2]]);
    expect(JSON.stringify(status)).not.toContain("push.example");
    expect(JSON.stringify(status)).not.toContain(auth);
  });

  it("enforces 16 rows transactionally, deletes idempotently, and advances work generation for preferences without VAPID rotation", async () => {
    let next = 1;
    const uuid = () => `${String(next++).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (let index = 0; index < 16; index++) {
      await make({ randomUUID: uuid }).register(registration(`https://push${index}.example/a`), `client-${index}`);
    }
    await expect(make({ randomUUID: uuid }).register(registration("https://overflow.example/a"), "overflow"))
      .rejects.toMatchObject({ status: 409, code: "push-device-limit" });
    expect((database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number }).count).toBe(16);

    const service = make();
    const generation = service.generation();
    const work = lifecycle.currentWorkGeneration();
    expect(service.setPreferences({ hideDetails: true })).toEqual({ hideDetails: true });
    expect(service.generation()).toBe(generation);
    expect(lifecycle.currentWorkGeneration()).toBe(work + 1);
    service.deleteDevice("ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(() => service.deleteDevice("not-a-uuid")).toThrow(PushApiError);
  });

  it("preserves actual rows on pre-delete revoke failure and never restores them after the commit point", () => {
    const seed = () => database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "https://push.example/a", keys.publicKey, auth, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const count = () => (database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number }).count;

    for (const [point, expectedRows, expectedReason] of [
      ["revoke-after-invalidate", 1, null],
      ["revoke-after-delete", 0, "recovery-pending"],
    ] as const) {
      database.prepare("DELETE FROM push_subscriptions").run();
      const dataDir = root();
      let active: string | undefined;
      const faulting = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
        fault: (at) => { if (at === active) throw new Error("synthetic revoke fault"); },
      });
      seed();
      const service = make({ lifecycle: faulting });
      active = point;
      expect(() => service.revokeAllDevices()).toThrow(PushApiError);
      expect(count()).toBe(expectedRows);
      expect(faulting.snapshot().reason).toBe(expectedReason);
      expect(fs.existsSync(path.join(dataDir, REVOKE_MARKER))).toBe(expectedRows === 0);
      active = undefined;
      if (expectedRows === 0) {
        const recovered = new PushLifecycle({
          dataDir,
          deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
        });
        expect(recovered.snapshot().available).toBe(true);
        expect(count()).toBe(0);
      }
    }
  });

  it("constructs the exact one-attempt test request and retains accepted test timestamps", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://push.example/test";
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, endpoint, keys.publicKey, auth, "2026-09-19T11:00:00.000Z", "2026-09-19T11:00:00.000Z");
    const generated: Array<{ subscription: unknown; payload: Buffer; options: Record<string, unknown> }> = [];
    const sent: unknown[] = [];
    const service = make({
      generateRequestDetails: (subscription, clear, options) => {
        generated.push({ subscription, payload: Buffer.from(clear), options: options as unknown as Record<string, unknown> });
        return { endpoint, method: "POST", headers: { authorization: "redacted" }, body: Buffer.alloc(4_096) };
      },
      transport: { send: async (request) => { sent.push(request); return "success"; } },
    });
    await expect(service.testDevice(deviceId)).resolves.toBeUndefined();
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.toString("utf8")).toBe('{"v":1,"kind":"test"}');
    expect(generated[0].subscription).toEqual({ endpoint, keys: { p256dh: keys.publicKey, auth } });
    expect(generated[0].options).toMatchObject({
      contentEncoding: "aes128gcm", TTL: 0, urgency: "normal", topic: "draw-push-test",
      vapidDetails: {
        subject: "https://github.com/FelixGeisler/draw",
        publicKey: lifecycle.signingAuthority()!.publicKey,
        privateKey: lifecycle.signingAuthority()!.privateKey,
      },
    });
    expect(sent).toHaveLength(1);
    await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 429, code: "push-rate-limited", retryAfter: 10 });
  });

  it("rejects every request-detail mismatch and encrypted oversize before transport creation", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://push.example/test";
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, endpoint, keys.publicKey, auth, "a", "b");
    let sends = 0;
    const cases: Array<[string, () => ReturnType<typeof webPush.generateRequestDetails>]> = [
      ["endpoint", () => ({ endpoint: "https://other.example/test", method: "POST", headers: {}, body: Buffer.from("encrypted") })],
      ["method", () => ({ endpoint, method: "GET", headers: {}, body: Buffer.from("encrypted") }) as unknown as ReturnType<typeof webPush.generateRequestDetails>],
      ["proxy", () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted"), proxy: "http://proxy.invalid" })],
      ["non-buffer body", () => ({ endpoint, method: "POST", headers: {}, body: "encrypted" }) as unknown as ReturnType<typeof webPush.generateRequestDetails>],
      ["oversized encrypted body", () => ({ endpoint, method: "POST", headers: {}, body: Buffer.alloc(4_097) })],
      ["generator exception", () => { throw new Error("private request-construction detail"); }],
    ];
    for (const [name, generateRequestDetails] of cases) {
      const service = make({
        generateRequestDetails,
        transport: { send: async () => { sends += 1; return "success"; } },
      });
      await expect(service.testDevice(deviceId), name).rejects.toMatchObject({ status: 502, code: "push-delivery-failed" });
    }
    expect(sends).toBe(0);
  });

  it("closes initial missing, expired and corrupt test states before transport", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let sends = 0;
    const service = make({ transport: { send: async () => { sends += 1; return "success"; } } });
    await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 404, code: "push-device-not-found" });
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, "https://push.example/test", keys.publicKey, auth, Date.parse("2026-09-19T11:59:59Z"), "a", "b");
    await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 410, code: "push-subscription-gone" });
    expect(database.prepare("SELECT id FROM push_subscriptions WHERE id=?").get(deviceId)).toBeUndefined();

    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, "http://private.invalid/test", "secret-key", "secret-auth", "a", "b");
    await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 502, code: "push-delivery-failed" });
    expect(sends).toBe(0);
  });

  it("cancels every named generation, lifecycle, setting, and row-fingerprint race with zero HTTPS creation", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherKeys = webPush.generateVAPIDKeys();
    const otherAuth = crypto.randomBytes(16).toString("base64url");
    const insert = (expiration: number | null = null) => database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, "https://push.example/test", keys.publicKey, auth, expiration, "created", "seen");
    let sends = 0;
    const cases: Array<[string, (service: PushService) => void]> = [
      ["authority work generation", () => lifecycle.advanceWorkGeneration()],
      ["Hide-details", () => { database.prepare("UPDATE settings SET value='1' WHERE key='push_hide_details'").run(); }],
      ["Hide-details away/back", (service) => {
        service.setPreferences({ hideDetails: true });
        service.setPreferences({ hideDetails: false });
      }],
      ["revoke", (service) => service.revokeAllDevices()],
      ["password reset", (service) => service.reset()],
      ["restore abort", (service) => { service.beginRestore(); service.abortRestore(); }],
      ["completed import", (service) => { service.beginRestore(); service.completeRestore(); }],
      ["missing row", () => { database.prepare("DELETE FROM push_subscriptions WHERE id=?").run(deviceId); }],
      ["replacement row", () => {
        database.prepare("DELETE FROM push_subscriptions WHERE id=?").run(deviceId);
        database.prepare(
          `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        ).run(deviceId, "https://push.example/replacement", keys.publicKey, auth, "replacement", "seen");
      }],
      ["endpoint", () => { database.prepare("UPDATE push_subscriptions SET endpoint='https://other.example/test' WHERE id=?").run(deviceId); }],
      ["p256dh", () => { database.prepare("UPDATE push_subscriptions SET p256dh=? WHERE id=?").run(otherKeys.publicKey, deviceId); }],
      ["auth", () => { database.prepare("UPDATE push_subscriptions SET auth=? WHERE id=?").run(otherAuth, deviceId); }],
      ["expiration", () => { database.prepare("UPDATE push_subscriptions SET expiration_time=? WHERE id=?").run(Date.parse("2026-09-20T12:00:00Z"), deviceId); }],
      ["created_at", () => { database.prepare("UPDATE push_subscriptions SET created_at='changed' WHERE id=?").run(deviceId); }],
      ["last_seen_at", () => { database.prepare("UPDATE push_subscriptions SET last_seen_at='changed' WHERE id=?").run(deviceId); }],
    ];
    for (const [name, mutate] of cases) {
      database.prepare("DELETE FROM push_subscriptions").run();
      database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
      insert();
      let mutated = false;
      let racing!: PushService;
      racing = make({
        resolverFactory: () => ({
          resolve4: async () => ["8.8.8.8"],
          resolve6: async () => {
            if (!mutated) { mutated = true; mutate(racing); }
            throw Object.assign(new Error("none"), { code: "ENODATA" });
          },
          cancel() {},
        }),
        transport: { send: async () => { sends += 1; return "success"; } },
      });
      await expect(racing.testDevice(deviceId), name).rejects.toMatchObject({ status: 409, code: "push-test-cancelled" });
    }

    database.prepare("DELETE FROM push_subscriptions").run();
    const expiry = Date.parse("2026-09-19T12:00:01Z");
    insert(expiry);
    let wall = expiry - 1;
    const expiryRace = make({
      wallNow: () => wall,
      resolverFactory: () => ({
        resolve4: async () => ["8.8.8.8"],
        resolve6: async () => { wall = expiry; throw Object.assign(new Error("none"), { code: "ENODATA" }); },
        cancel() {},
      }),
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    await expect(expiryRace.testDevice(deviceId)).rejects.toMatchObject({ status: 409, code: "push-test-cancelled" });
    expect(database.prepare("SELECT id FROM push_subscriptions WHERE id=?").get(deviceId)).toBeUndefined();
    expect(sends).toBe(0);
  });

  it("holds all four shared permits until delayed local request, response, and socket closure", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`);
    ids.forEach((id, index) => database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, `https://push${index}.example/test`, keys.publicKey, auth, "a", "b"));

    interface HeldSend {
      providerComplete(): void;
      close(kind: "request" | "response" | "socket"): void;
    }
    const held: HeldSend[] = [];
    const transport: PushTransport = {
      send: () => new Promise((resolve) => {
        let complete = false;
        const open = new Set(["request", "response", "socket"] as const);
        const settle = () => { if (complete && open.size === 0) resolve("success"); };
        held.push({
          providerComplete: () => { complete = true; settle(); },
          close: (kind) => { open.delete(kind); settle(); },
        });
      }),
    };
    const admission = new PushAdmission(() => 0);
    const service = make({
      admission,
      generateRequestDetails: (subscription) => ({
        endpoint: subscription.endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted"),
      }),
      transport,
    });
    const attempts = ids.slice(0, 4).map((id) => service.testDevice(id));
    for (let spins = 0; held.length < 4 && spins < 20; spins++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toHaveLength(4);
    expect(admission.snapshot()).toMatchObject({ active: 4, testInFlight: 4 });
    await expect(service.testDevice(ids[4])).rejects.toMatchObject({ status: 503, code: "push-busy" });

    held[0].providerComplete();
    held[0].close("request");
    held[0].close("response");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admission.snapshot()).toMatchObject({ active: 4, testInFlight: 4 });
    await expect(service.testDevice(ids[4])).rejects.toMatchObject({ status: 503, code: "push-busy" });

    held[0].close("socket");
    await attempts[0];
    const fifth = service.testDevice(ids[4]);
    for (let spins = 0; held.length < 5 && spins < 20; spins++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toHaveLength(5);
    for (const item of held.slice(1)) {
      item.providerComplete();
      item.close("request");
      item.close("response");
      item.close("socket");
    }
    await Promise.all([...attempts.slice(1), fifth]);
    expect(admission.snapshot()).toMatchObject({ active: 0, testInFlight: 0, testGlobal: 5 });
  });

  it("maps the bounded provider matrix and total deadline to closed delivery errors", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://push.example/test";
    const insert = () => database.prepare(
      `INSERT OR REPLACE INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, endpoint, keys.publicKey, auth, "a", "b");
    for (const [outcome, expected] of [["failed", 502], ["timeout", 504], ["gone", 410]] as const) {
      insert();
      const service = make({
        generateRequestDetails: () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") }),
        transport: { send: async () => outcome },
      });
      await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: expected });
    }

    insert();
    const rejects: Array<(reason: unknown) => void> = [];
    const pending: IsolatedResolver = {
      resolve4: () => new Promise((_resolve, reject) => rejects.push(reject)),
      resolve6: () => new Promise((_resolve, reject) => rejects.push(reject)),
      cancel: () => rejects.splice(0).forEach((reject) => reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }))),
    };
    const total = make({ resolverFactory: () => pending, dnsDeadlineMs: 100, totalAttemptMs: 2 });
    await expect(total.testDevice(deviceId)).rejects.toMatchObject({ status: 504, code: "push-timeout" });
  });

  it("keeps response-first classification while delayed local closure holds admission past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const endpoint = "https://push.example/test";
      const scenarios: Array<{
        name: string;
        terminalAtThreeMs?: PushTransportResult;
        expectedStatus?: number;
      }> = [
        { name: "complete 302", terminalAtThreeMs: "failed", expectedStatus: 502 },
        { name: "complete 500", terminalAtThreeMs: "failed", expectedStatus: 502 },
        { name: "complete 404", terminalAtThreeMs: "gone", expectedStatus: 410 },
        { name: "complete 410", terminalAtThreeMs: "gone", expectedStatus: 410 },
        { name: "complete 204", terminalAtThreeMs: "success" },
        { name: "network failure", terminalAtThreeMs: "failed", expectedStatus: 502 },
        { name: "incomplete response", expectedStatus: 504 },
      ];

      for (const scenario of scenarios) {
        database.prepare("DELETE FROM push_subscriptions").run();
        database.prepare(
          `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        ).run(deviceId, endpoint, keys.publicKey, auth, "a", "b");

        let monotonicNow = 0;
        let transportStarted = false;
        let terminal: PushTransportResult | undefined;
        let terminalAt: number | undefined;
        let physicallyClosedAt: number | undefined;
        const admission = new PushAdmission(() => monotonicNow);
        const transport: PushTransport = {
          send: ({ signal, timedOut }) => new Promise((resolve) => {
            transportStarted = true;
            const becomeTerminal = (outcome: PushTransportResult) => {
              if (terminal !== undefined) return;
              terminal = outcome;
              terminalAt = monotonicNow;
            };
            if (scenario.terminalAtThreeMs !== undefined) {
              setTimeout(() => becomeTerminal(scenario.terminalAtThreeMs!), 3);
            }
            signal.addEventListener("abort", () => {
              if (terminal === undefined) becomeTerminal(timedOut() ? "timeout" : "aborted");
              setTimeout(() => {
                physicallyClosedAt = monotonicNow;
                resolve(terminal!);
              }, 51);
            }, { once: true });
          }),
        };
        const service = make({
          admission,
          totalAttemptMs: 15,
          generateRequestDetails: () => ({ endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") }),
          transport,
        });
        const attempt = service.testDevice(deviceId).then(
          () => ({ status: 204 }),
          (error: unknown) => ({ status: error instanceof PushApiError ? error.status : -1 }),
        );
        let settled = false;
        void attempt.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(transportStarted, scenario.name).toBe(true);

        monotonicNow = 3;
        await vi.advanceTimersByTimeAsync(3);
        expect(terminalAt, scenario.name).toBe(scenario.terminalAtThreeMs === undefined ? undefined : 3);
        expect(admission.snapshot(), scenario.name).toMatchObject({ active: 1, testInFlight: 1 });

        monotonicNow = 15;
        await vi.advanceTimersByTimeAsync(12);
        expect(terminalAt, scenario.name).toBe(scenario.terminalAtThreeMs === undefined ? 15 : 3);
        expect(settled, scenario.name).toBe(false);
        expect(admission.snapshot(), scenario.name).toMatchObject({ active: 1, testInFlight: 1 });

        monotonicNow = 65;
        await vi.advanceTimersByTimeAsync(50);
        expect(settled, scenario.name).toBe(false);
        expect(admission.snapshot(), scenario.name).toMatchObject({ active: 1, testInFlight: 1 });

        monotonicNow = 66;
        await vi.advanceTimersByTimeAsync(1);
        expect(physicallyClosedAt, scenario.name).toBe(66);
        expect((await attempt).status, scenario.name).toBe(scenario.expectedStatus ?? 204);
        expect(admission.snapshot(), scenario.name).toMatchObject({ active: 0, testInFlight: 0 });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains same-endpoint rate state and clears only rows removed by committed replacement, delete, revoke, reset, and import", async () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ];
    const endpoint = "https://push.example/a";
    const admission = new PushAdmission(() => 0);
    const cleanupLifecycle = new PushLifecycle({
      dataDir: root(),
      deleteSubscriptions: () => {
        const removed = database.transaction(() => {
          const rows = database.prepare("SELECT id FROM push_subscriptions").all() as Array<{ id: string }>;
          database.prepare("DELETE FROM push_subscriptions").run();
          return rows.map((row) => row.id);
        })();
        removed.forEach((id) => admission.removeDevice(id));
      },
    });
    const markRate = (id: string) => {
      const decision = admission.tryAcquireTest(id);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) decision.release();
    };
    const insert = (id: string, value: string) => database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, value, keys.publicKey, auth, "a", "b");
    insert(ids[0], endpoint);
    markRate(ids[0]);
    const service = make({ admission, lifecycle: cleanupLifecycle, randomUUID: () => ids[1] });

    const same = await service.register(registration(endpoint), "same-client");
    expect(same.device.id).toBe(ids[0]);
    expect(admission.snapshot().testDevices).toBe(1);

    const replacement = await service.register(registration("https://push.example/b", ids[0]), "replace-client");
    expect(replacement.device.id).toBe(ids[1]);
    expect(admission.snapshot().testDevices).toBe(0);

    markRate(ids[1]);
    service.deleteDevice(ids[1]);
    expect(admission.snapshot().testDevices).toBe(0);

    insert(ids[2], "https://push.example/c");
    markRate(ids[2]);
    service.revokeAllDevices();
    expect(admission.snapshot().testDevices).toBe(0);

    insert(ids[3], "https://push.example/d");
    markRate(ids[3]);
    service.reset();
    expect(admission.snapshot().testDevices).toBe(0);

    insert(ids[4], "https://push.example/e");
    markRate(ids[4]);
    service.beginRestore();
    service.completeRestore();
    expect(admission.snapshot()).toMatchObject({ testDevices: 0, testGlobal: 5 });
  });

  it("returns gone for a late stale provider result without deleting the changed row or rate state", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, "https://push.example/test", keys.publicKey, auth, "a", "b");
    const admission = new PushAdmission(() => 0);
    const changedAuth = crypto.randomBytes(16).toString("base64url");
    const service = make({
      admission,
      transport: { send: async () => {
        database.prepare("UPDATE push_subscriptions SET auth=?, last_seen_at='new' WHERE id=?").run(changedAuth, deviceId);
        return "gone";
      } },
    });
    await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 410, code: "push-subscription-gone" });
    expect(database.prepare("SELECT auth FROM push_subscriptions WHERE id=?").get(deviceId)).toEqual({ auth: changedAuth });
    expect(admission.snapshot()).toMatchObject({ testDevices: 1, testGlobal: 1 });
  });

  it("never logs any prohibited request, credential, provider, payload, address, or user value", async () => {
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpoint = "https://secret-host.example/private/path?token=endpoint-secret";
    const selectedAddress = "203.0.113.77";
    const providerSecret = "provider-body-and-header-secret";
    const rawException = `TLS failed for ${endpoint}: ${providerSecret}`;
    database.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(deviceId, endpoint, keys.publicKey, auth, "user-created-at", "user-last-seen-at");
    const calls: unknown[][] = [];
    const capture = (...values: unknown[]) => { calls.push(values); };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
    ];
    try {
      const service = make({
        resolverFactory: () => ({
          resolve4: async () => [selectedAddress],
          resolve6: async () => { throw Object.assign(new Error(rawException), { code: "ENODATA" }); },
          cancel() {},
        }),
        generateRequestDetails: () => ({
          endpoint, method: "POST",
          headers: { authorization: "private-authority-header", "x-provider-secret": providerSecret },
          body: Buffer.from("encrypted-payload-secret"),
        }),
        transport: { send: async () => { throw new Error(rawException); } },
      });
      await expect(service.testDevice(deviceId)).rejects.toMatchObject({ status: 502, code: "push-delivery-failed" });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const output = JSON.stringify(calls);
    for (const prohibited of [
      "secret-host.example", "/private/path", "endpoint-secret", selectedAddress,
      keys.publicKey, auth, lifecycle.signingAuthority()!.privateKey,
      "private-authority-header", providerSecret, "encrypted-payload-secret", rawException,
      "user-created-at", "user-last-seen-at", '{"v":1,"kind":"test"}',
    ]) expect(output).not.toContain(prohibited);
  });

  it("retains accepted rate timestamps across DNS failure and maps unavailable/deadline errors exactly", async () => {
    const unavailable = make({ resolverFactory: () => ({
      resolve4: async () => { throw Object.assign(new Error("hidden"), { code: "ESERVFAIL" }); },
      resolve6: async () => { throw Object.assign(new Error("hidden"), { code: "ENODATA" }); },
      cancel() {},
    }) });
    for (let index = 0; index < 4; index++) {
      await expect(unavailable.register(registration(`https://failed${index}.example/a`), "same-client"))
        .rejects.toMatchObject({ status: 502, code: "push-endpoint-unavailable" });
    }
    await expect(unavailable.register(registration("https://limited.example/a"), "same-client"))
      .rejects.toMatchObject({ status: 429, code: "push-rate-limited", retryAfter: 60 });

    const timeout = make({ resolverFactory: () => {
      const rejects: ((reason: unknown) => void)[] = [];
      return {
        resolve4: () => new Promise((_resolve, reject) => rejects.push(reject)),
        resolve6: () => new Promise((_resolve, reject) => rejects.push(reject)),
        cancel: () => rejects.splice(0).forEach((reject) => reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }))),
      };
    }, dnsDeadlineMs: 2 });
    await expect(timeout.register(registration("https://timeout.example/a"), "other-client"))
      .rejects.toMatchObject({ status: 504, code: "push-timeout" });
  });

  it("holds four logical/eight physical operations through delayed abort and timeout settlement", async () => {
    class Pending implements IsolatedResolver {
      static physical = 0;
      static maxPhysical = 0;
      cancelled = false;
      private operations: Array<{ reject: (reason: unknown) => void; settled: boolean }> = [];

      private resolve(): Promise<string[]> {
        Pending.physical += 1;
        Pending.maxPhysical = Math.max(Pending.maxPhysical, Pending.physical);
        return new Promise<string[]>((_resolve, reject) => this.operations.push({ reject, settled: false }))
          .finally(() => { Pending.physical -= 1; });
      }
      resolve4(): Promise<string[]> { return this.resolve(); }
      resolve6(): Promise<string[]> { return this.resolve(); }
      cancel(): void { this.cancelled = true; }
      settle(index: number): void {
        const operation = this.operations[index];
        if (!operation || operation.settled) return;
        operation.settled = true;
        operation.reject(Object.assign(new Error("cancel"), { code: "ECANCELLED" }));
      }
      settleAll(): void { this.operations.forEach((_operation, index) => this.settle(index)); }
    }
    const admission = new PushAdmission();
    const resolvers: Pending[] = [];
    const service = make({
      admission,
      resolverFactory: () => { const value = new Pending(); resolvers.push(value); return value; },
      dnsDeadlineMs: 10,
    });
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const held = aborts.map((abort, index) =>
      service.register(registration(`https://pending${index}.example/a`), `client-${index}`, abort.signal));
    const outcomes = held.map((attempt) => attempt.catch((error: unknown) => error));
    await new Promise((resolve) => setTimeout(resolve, 0));
    aborts[0].abort();
    aborts[1].abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolvers).toHaveLength(4);
    expect(resolvers.every((resolver) => resolver.cancelled)).toBe(true);
    expect(Pending.physical).toBe(8);
    expect(Pending.maxPhysical).toBe(8);
    await expect(service.register(registration("https://fifth.example/a"), "fifth"))
      .rejects.toMatchObject({ code: "push-busy" });

    let firstSettled = false;
    void outcomes[0].then(() => { firstSettled = true; });
    resolvers[0].settle(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).toBe(false);
    expect(Pending.physical).toBe(7);
    await expect(service.register(registration("https://still-busy.example/a"), "still-busy"))
      .rejects.toMatchObject({ code: "push-busy" });

    resolvers[0].settle(1);
    expect(await outcomes[0]).toMatchObject({ kind: "aborted" });
    const sixthAbort = new AbortController();
    const sixth = service.register(registration("https://sixth.example/a"), "sixth", sixthAbort.signal);
    const sixthOutcome = sixth.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolvers).toHaveLength(5);
    expect(Pending.physical).toBe(8);
    expect(Pending.maxPhysical).toBe(8);

    sixthAbort.abort();
    resolvers.slice(1).forEach((resolver) => resolver.settleAll());
    expect(await outcomes[1]).toMatchObject({ kind: "aborted" });
    expect(await outcomes[2]).toMatchObject({ status: 504, code: "push-timeout" });
    expect(await outcomes[3]).toMatchObject({ status: 504, code: "push-timeout" });
    expect(await sixthOutcome).toMatchObject({ kind: "aborted" });
    expect(Pending.physical).toBe(0);
  });
});
