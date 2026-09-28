import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushAdmission } from "../../src/push/admission.js";
import { PushLifecycle } from "../../src/push/authority.js";
import {
  digestEventId,
  startDigestScheduler,
  type DigestTimer,
} from "../../src/push/digestScheduler.js";
import { PushService } from "../../src/push/service.js";
import type { IsolatedResolver } from "../../src/push/resolver.js";
import { testDb } from "../helpers.js";

const roots: string[] = [];
const keys = webPush.generateVAPIDKeys();
const auth = crypto.randomBytes(16).toString("base64url");
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const inertTimer: DigestTimer = { set: () => ({}), clear: () => {} };
const resolver = (): IsolatedResolver => ({
  resolve4: async () => ["8.8.8.8"],
  resolve6: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); },
  cancel() {},
});

describe("automatic daily digest scheduler", () => {
  let database: Awaited<ReturnType<typeof testDb>>;
  let lifecycle: PushLifecycle;
  let instant: Date;

  beforeEach(async () => {
    database = await testDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-digest-scheduler-"));
    roots.push(root);
    lifecycle = new PushLifecycle({
      dataDir: root,
      deleteSubscriptions: () => database.prepare("DELETE FROM push_subscriptions").run(),
    });
    database.prepare("DELETE FROM daily_digest_claims").run();
    database.prepare("DELETE FROM push_subscriptions").run();
    database.prepare("DELETE FROM tasks").run();
    database.prepare("DELETE FROM goals").run();
    database.prepare("UPDATE settings SET value='09:00' WHERE key='push_send_time'").run();
    database.prepare("UPDATE settings SET value='UTC' WHERE key='push_timezone'").run();
    database.prepare("UPDATE settings SET value=NULL WHERE key IN ('push_quiet_start','push_quiet_end')").run();
    database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
    instant = new Date("2026-09-20T09:00:00Z");
    addDevice(deviceId, "push.example");
  });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function addDevice(id: string, host: string, expiration: number | null = null) {
    database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES (?,?,?,?,?,'device-created','device-seen')`,
    ).run(id, `https://${host}/digest/${id}`, keys.publicKey, auth, expiration);
  }

  function task(id: number, title: string, due: string, status = "open") {
    database.prepare(
      `INSERT INTO tasks(id,title,category_id,due_date,status,created_at)
       VALUES (?,?,1,?,?,?)`,
    ).run(id, title, due, status, `task-${id}`);
  }

  function goal(id: number, title: string, target: string, status = "active") {
    database.prepare(
      "INSERT INTO goals(id,title,target_date,status,created_at) VALUES (?,?,?,?,?)",
    ).run(id, title, target, status, `goal-${id}`);
  }

  function service(overrides: Partial<ConstructorParameters<typeof PushService>[0]> = {}) {
    return new PushService({
      database: () => database,
      lifecycle,
      topology: { listenerHost: "127.0.0.1", listenerPort: 3001, trustProxy: false },
      resolverFactory: resolver,
      wallNow: () => instant.valueOf(),
      generateRequestDetails: (subscription, _payload, options) => ({
        endpoint: subscription.endpoint,
        method: "POST",
        headers: { TTL: String(options.TTL), Topic: String(options.topic) },
        body: Buffer.from("encrypted"),
      }),
      transport: { send: async () => "success" },
      ...overrides,
    });
  }

  function scheduler(push: PushService) {
    return startDigestScheduler({ database: () => database, push, now: () => instant, timer: inertTimer });
  }

  it("claims before DNS, sends zero-item dates once, and deduplicates restart/repeated ticks", async () => {
    let dnsSawClaim = false;
    let sends = 0;
    const payloads: unknown[] = [];
    const push = service({
      resolverFactory: () => ({ ...resolver(), resolve4: async () => {
        expect(database.inTransaction).toBe(false);
        dnsSawClaim = Boolean(database.prepare("SELECT 1 FROM daily_digest_claims").get());
        return ["8.8.8.8"];
      } }),
      observeDigestPayload: (payload) => payloads.push(JSON.parse(payload.toString("utf8"))),
      transport: { send: async () => {
        expect(database.inTransaction).toBe(false);
        sends += 1;
        return "success";
      } },
    });
    const first = scheduler(push);
    await first.runNow();
    await first.runNow();
    first.stop();
    const restarted = scheduler(push);
    await restarted.runNow();
    restarted.stop();

    const eventId = digestEventId("2026-09-20");
    expect(dnsSawClaim).toBe(true);
    expect(sends).toBe(1);
    expect(payloads).toEqual([{
      v: 2, kind: "digest", detail: "detailed", eventId,
      todayCount: 0, tomorrowCount: 0, overdueCount: 0, titles: [], remainingCount: 0,
    }]);
    expect(database.prepare("SELECT * FROM daily_digest_claims").all())
      .toEqual([{ device_id: deviceId, local_date: "2026-09-20" }]);
  });

  it("keeps a fixed-only task out of the actual v2 digest evaluation and serialized payload", async () => {
    database.prepare(
      `INSERT INTO tasks(id,title,category_id,due_date,status,created_at)
       VALUES (41,'FIXED ONLY DIGEST CANARY',1,NULL,'open','fixed-created')`,
    ).run();
    database.prepare(
      `INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone)
       VALUES (41,'2026-09-20T09:15:00.000Z','2026-09-20T10:00:00.000Z','UTC')`,
    ).run();
    const payloads: Record<string, unknown>[] = [];
    const run = scheduler(service({
      observeDigestPayload: (payload) => payloads.push(JSON.parse(payload.toString("utf8"))),
    }));
    await run.runNow();
    run.stop();

    expect(payloads).toEqual([expect.objectContaining({
      v: 2,
      kind: "digest",
      detail: "detailed",
      todayCount: 0,
      tomorrowCount: 0,
      overdueCount: 0,
      titles: [],
      remainingCount: 0,
    })]);
    const serialized = JSON.stringify(payloads[0]);
    expect(serialized).not.toContain("FIXED ONLY DIGEST CANARY");
    expect(serialized).not.toContain("09:15");
  });

  it("uses complete SQL counts and at most five deterministic title rows", async () => {
    goal(2, "old goal", "2026-09-17");
    task(2, "old task", "2026-09-17");
    goal(1, "less old goal", "2026-09-19");
    task(1, "today task", "2026-09-20");
    goal(3, "tomorrow goal", "2026-09-21");
    task(3, "sixth title", "2026-09-21");
    task(9, "resolved", "2026-09-20", "done");
    goal(9, "malformed", "2026-02-30");
    const payloads: Record<string, unknown>[] = [];
    const push = service({ observeDigestPayload: (payload) => payloads.push(JSON.parse(payload.toString("utf8"))) });
    const run = scheduler(push);
    await run.runNow();
    run.stop();
    expect(payloads).toEqual([expect.objectContaining({
      overdueCount: 3, todayCount: 1, tomorrowCount: 2,
      titles: ["old goal", "old task", "less old goal", "today task", "tomorrow goal"],
      remainingCount: 1,
    })]);
  });

  it("deduplicates both fall-fold instants across a scheduler restart", async () => {
    database.prepare("UPDATE settings SET value='01:30' WHERE key='push_send_time'").run();
    database.prepare("UPDATE settings SET value='America/New_York' WHERE key='push_timezone'").run();
    let sends = 0;
    const push = service({ transport: { send: async () => { sends += 1; return "success"; } } });
    instant = new Date("2026-11-01T05:30:00Z");
    const first = scheduler(push);
    await first.runNow();
    first.stop();

    instant = new Date("2026-11-01T06:30:00Z");
    const restarted = scheduler(push);
    await restarted.runNow();
    restarted.stop();

    expect(sends).toBe(1);
    expect(database.prepare("SELECT * FROM daily_digest_claims").all())
      .toEqual([{ device_id: deviceId, local_date: "2026-11-01" }]);
  });

  it("leaves busy devices unclaimed and shares at most four physical attempts", async () => {
    const busy = scheduler(service({ admission: new PushAdmission(() => 0, { active: 4 }) }));
    await busy.runNow();
    expect(database.prepare("SELECT * FROM daily_digest_claims").all()).toEqual([]);
    busy.stop();

    database.prepare("DELETE FROM push_subscriptions").run();
    for (let index = 0; index < 8; index++) {
      addDevice(`00000000-0000-4000-8000-0000000000${index}`, `push${index}.example`);
    }
    let active = 0;
    let peak = 0;
    let sends = 0;
    const parallel = scheduler(service({ transport: { send: async () => {
      sends += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return "success";
    } } }));
    await parallel.runNow();
    parallel.stop();
    expect({ sends, peak }).toEqual({ sends: 8, peak: 4 });
  });

  it("releases the shared permit when claim/database work throws and admits the next tick", async () => {
    const admission = new PushAdmission(() => 0);
    const logs: string[] = [];
    let databaseCalls = 0;
    let failClaimLookup = true;
    let sends = 0;
    const push = service({
      admission,
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const run = startDigestScheduler({
      database: () => {
        databaseCalls += 1;
        if (failClaimLookup && databaseCalls === 2) throw new Error("SECRET claim failure");
        return database;
      },
      push,
      now: () => instant,
      timer: inertTimer,
      log: (message) => logs.push(message),
    });

    await run.runNow();
    expect(admission.snapshot().active).toBe(0);
    expect(logs).toEqual(["[push] digest tick failed (redacted)"]);
    expect(logs.join(" ")).not.toContain("SECRET");
    failClaimLookup = false;
    await run.runNow();
    run.stop();
    expect(sends).toBe(1);
    expect(admission.snapshot().active).toBe(0);
  });

  it("retains a claim after DNS/provider failure and never retries", async () => {
    let resolutions = 0;
    const dnsFailure = scheduler(service({ resolverFactory: () => ({
      resolve4: async () => { resolutions += 1; throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); },
      resolve6: async () => { resolutions += 1; throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); },
      cancel() {},
    }) }));
    await dnsFailure.runNow();
    const first = resolutions;
    await dnsFailure.runNow();
    expect(resolutions).toBe(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
    dnsFailure.stop();

    database.prepare("DELETE FROM daily_digest_claims").run();
    let calls = 0;
    const providerFailure = scheduler(service({ transport: { send: async () => { calls += 1; return "failed"; } } }));
    await providerFailure.runNow();
    await providerFailure.runNow();
    expect(calls).toBe(1);
    providerFailure.stop();
  });

  it("cancels every post-DNS policy/subscription race while retaining the claim", async () => {
    const mutations: Array<() => void> = [
      () => lifecycle.advanceWorkGeneration(),
      () => database.prepare("UPDATE push_subscriptions SET endpoint='https://changed.example/x' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET p256dh='changed' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET auth='changed' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET expiration_time=? WHERE id=?").run(instant.valueOf(), deviceId),
      () => database.prepare("UPDATE push_subscriptions SET created_at='changed' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET last_seen_at='changed' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE settings SET value='1' WHERE key='push_hide_details'").run(),
      () => database.prepare("UPDATE settings SET value='09:15' WHERE key='push_send_time'").run(),
      () => database.prepare("UPDATE settings SET value='Europe/Berlin' WHERE key='push_timezone'").run(),
      () => database.prepare("UPDATE settings SET value='09:00' WHERE key='push_quiet_start'").run(),
      () => database.prepare("UPDATE settings SET value='09:15' WHERE key='push_quiet_end'").run(),
      () => { instant = new Date("2026-09-20T12:00:00Z"); },
      () => lifecycle.invalidate(),
    ];
    for (const mutate of mutations) {
      database.prepare("DELETE FROM daily_digest_claims").run();
      database.prepare("DELETE FROM push_subscriptions").run();
      addDevice(deviceId, "push.example");
      database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
      database.prepare("UPDATE settings SET value='09:00' WHERE key='push_send_time'").run();
      database.prepare("UPDATE settings SET value='UTC' WHERE key='push_timezone'").run();
      database.prepare("UPDATE settings SET value=NULL WHERE key IN ('push_quiet_start','push_quiet_end')").run();
      instant = new Date("2026-09-20T09:00:00Z");
      let sends = 0;
      const run = scheduler(service({ resolverFactory: () => ({ ...resolver(), resolve4: async () => {
        mutate();
        return ["8.8.8.8"];
      } }), transport: { send: async () => { sends += 1; return "success"; } } }));
      await run.runNow();
      expect(sends).toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
      run.stop();
    }
  });

  it("supports timezone-change suppression, skipped-date no replay, and a new date under 24 hours", async () => {
    let sends = 0;
    const run = scheduler(service({ transport: { send: async () => { sends += 1; return "success"; } } }));
    await run.runNow();
    database.prepare("UPDATE settings SET value='Pacific/Kiritimati' WHERE key='push_timezone'").run();
    instant = new Date("2026-09-20T19:00:00Z"); // 2026-09-21 09:00 (+14), ten elapsed hours later
    await run.runNow();
    await run.runNow();
    expect(sends).toBe(2);
    expect(database.prepare("SELECT local_date FROM daily_digest_claims ORDER BY local_date").all())
      .toEqual([{ local_date: "2026-09-20" }, { local_date: "2026-09-21" }]);
    instant = new Date("2026-09-22T23:00:00Z"); // 13:00 local, after the date's window; no backlog
    await run.runNow();
    expect(sends).toBe(2);
    run.stop();
  });

  it("uses remaining TTL/topic and clear-body detailed-to-generic size fallback", async () => {
    task(1, "x".repeat(4_000), "2026-09-20");
    instant = new Date("2026-09-20T10:00:00.250Z");
    const generated: Array<{ payload: Record<string, unknown>; ttl: number; topic: string }> = [];
    const run = scheduler(service({
      generateRequestDetails: (subscription, payload, options) => {
        const parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        generated.push({ payload: parsed, ttl: Number(options.TTL), topic: String(options.topic) });
        return { endpoint: subscription.endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") };
      },
    }));
    await run.runNow();
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ ttl: 7_199, topic: digestEventId("2026-09-20"), payload: { detail: "generic" } });
    expect(JSON.stringify(generated[0].payload)).not.toContain("x".repeat(100));
    run.stop();
  });

  it("constructs only generic and performs zero title reads when Hide-details is final", async () => {
    task(1, "PRIVATE TITLE CANARY", "2026-09-20");
    database.prepare("UPDATE settings SET value='1' WHERE key='push_hide_details'").run();
    let titleStatementPrepares = 0;
    const guarded = new Proxy(database, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("SELECT title FROM tasks") || sql.includes("SELECT title FROM goals")) {
            titleStatementPrepares += 1;
            throw new Error("title read forbidden for Hide-details");
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const constructed: string[] = [];
    let sends = 0;
    const run = scheduler(service({
      database: () => guarded,
      generateRequestDetails: (subscription, payload) => {
        constructed.push((JSON.parse(payload.toString("utf8")) as { detail: string }).detail);
        return { endpoint: subscription.endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") };
      },
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    await run.runNow();
    run.stop();
    expect({ titleStatementPrepares, sends }).toEqual({ titleStatementPrepares: 0, sends: 1 });
    expect(constructed).toEqual(["generic"]);
  });

  it("falls back on a 4097-byte encrypted detailed body and sends nothing when generic is oversized", async () => {
    task(1, "PRIVATE TITLE CANARY", "2026-09-20");
    const constructed: string[] = [];
    const observed: Record<string, unknown>[] = [];
    let sends = 0;
    const fallback = scheduler(service({
      generateRequestDetails: (subscription, payload) => {
        const parsed = JSON.parse(payload.toString("utf8")) as { detail: string };
        constructed.push(parsed.detail);
        return {
          endpoint: subscription.endpoint,
          method: "POST",
          headers: {},
          body: Buffer.alloc(parsed.detail === "detailed" ? 4_097 : 64),
        };
      },
      observeDigestPayload: (payload) => observed.push(JSON.parse(payload.toString("utf8"))),
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    await fallback.runNow();
    fallback.stop();
    expect(constructed).toEqual(["detailed", "generic"]);
    expect(sends).toBe(1);
    expect(observed).toEqual([expect.objectContaining({ detail: "generic", todayCount: 1 })]);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE TITLE CANARY");

    database.prepare("DELETE FROM daily_digest_claims").run();
    constructed.length = 0;
    observed.length = 0;
    sends = 0;
    const rejected = scheduler(service({
      generateRequestDetails: (subscription, payload) => {
        constructed.push((JSON.parse(payload.toString("utf8")) as { detail: string }).detail);
        return { endpoint: subscription.endpoint, method: "POST", headers: {}, body: Buffer.alloc(4_097) };
      },
      observeDigestPayload: (payload) => observed.push(JSON.parse(payload.toString("utf8"))),
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    await rejected.runNow();
    rejected.stop();
    expect(constructed).toEqual(["detailed", "generic"]);
    expect({ sends, observed }).toEqual({ sends: 0, observed: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
  });

  it("retains claims when content or request construction fails and when transport times out", async () => {
    let sends = 0;
    const constructionFailure = scheduler(service({
      generateRequestDetails: () => { throw new Error("synthetic construction failure"); },
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    await constructionFailure.runNow();
    await constructionFailure.runNow();
    constructionFailure.stop();
    expect(sends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });

    database.prepare("DELETE FROM daily_digest_claims").run();
    let timedAttempts = 0;
    const timeout = scheduler(service({
      totalAttemptMs: 5,
      transport: { send: ({ signal }) => new Promise((resolve) => {
        timedAttempts += 1;
        signal.addEventListener("abort", () => resolve("timeout"), { once: true });
      }) },
    }));
    await timeout.runNow();
    await timeout.runNow();
    timeout.stop();
    expect(timedAttempts).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
  });

  it("retains the claim and creates no request when the shared content query fails", async () => {
    let sends = 0;
    let failContent = false;
    const failingView = new Proxy(database, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          if (failContent && sql.includes("eligible(type,id,date,created_at)")) {
            throw new Error("synthetic content-query failure");
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = scheduler(service({
      database: () => failingView,
      resolverFactory: () => ({ ...resolver(), resolve4: async () => {
        failContent = true;
        return ["8.8.8.8"];
      } }),
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    await run.runNow();
    run.stop();
    expect(sends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
  });

  it("skips expired devices and deletes only the exact provider-gone fingerprint", async () => {
    database.prepare("UPDATE push_subscriptions SET expiration_time=? WHERE id=?")
      .run(instant.valueOf(), deviceId);
    const expired = scheduler(service());
    await expired.runNow();
    expired.stop();
    expect(database.prepare("SELECT * FROM daily_digest_claims").all()).toEqual([]);

    database.prepare("UPDATE push_subscriptions SET expiration_time=NULL WHERE id=?").run(deviceId);
    const gone = scheduler(service({ transport: { send: async () => "gone" } }));
    await gone.runNow();
    gone.stop();
    expect(database.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM daily_digest_claims").all()).toEqual([]);

    addDevice(deviceId, "push.example");
    const raced = scheduler(service({ transport: { send: async () => {
      database.prepare("UPDATE push_subscriptions SET last_seen_at='newer' WHERE id=?").run(deviceId);
      return "gone";
    } } }));
    await raced.runNow();
    raced.stop();
    expect(database.prepare("SELECT last_seen_at FROM push_subscriptions WHERE id=?").get(deviceId))
      .toEqual({ last_seen_at: "newer" });
    expect(database.prepare("SELECT * FROM daily_digest_claims").all())
      .toEqual([{ device_id: deviceId, local_date: "2026-09-20" }]);
  });

  it("retains a claim and never initiates when stopped during DNS", async () => {
    let release!: () => void;
    const held = new Promise<string[]>((resolve) => { release = () => resolve(["8.8.8.8"]); });
    let sends = 0;
    const run = scheduler(service({
      resolverFactory: () => ({ ...resolver(), resolve4: async () => held }),
      transport: { send: async () => { sends += 1; return "success"; } },
    }));
    const pending = run.runNow();
    for (let spin = 0; spin < 20 && !database.prepare("SELECT 1 FROM daily_digest_claims").get(); spin++) {
      await Promise.resolve();
    }
    run.stop();
    release();
    await pending;
    expect(sends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_digest_claims").get()).toEqual({ count: 1 });
  });

  it("makes stop idempotent, aborts only before initiation, and prevents overlap", async () => {
    let run: ReturnType<typeof startDigestScheduler>;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let initiated = 0;
    let signalAfterStop: boolean | undefined;
    run = scheduler(service({ transport: { send: async ({ signal }) => {
      initiated += 1;
      run.stop();
      signalAfterStop = signal.aborted;
      await held;
      return "success";
    } } }));
    const pending = run.runNow();
    for (let spin = 0; spin < 20 && initiated === 0; spin++) await Promise.resolve();
    expect(initiated).toBe(1);
    expect(signalAfterStop).toBe(false);
    await run.runNow();
    expect(initiated).toBe(1);
    run.stop();
    release();
    await pending;
  });

  it("recursively reschedules after a redacted failure and is structurally non-overlapping", async () => {
    const callbacks: Array<() => void> = [];
    const timer: DigestTimer = { set: (callback) => { callbacks.push(callback); return {}; }, clear: vi.fn() };
    const logs: string[] = [];
    let reads = 0;
    const run = startDigestScheduler({
      database: () => { reads += 1; if (reads === 1) throw new Error("secret"); return database; },
      push: service(), now: () => instant, timer, log: (message) => logs.push(message),
    });
    callbacks.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toEqual(["[push] digest tick failed (redacted)"]);
    expect(callbacks).toHaveLength(1);
    run.stop();
  });
});
