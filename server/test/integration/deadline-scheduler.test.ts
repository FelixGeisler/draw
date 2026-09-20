import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushAdmission } from "../../src/push/admission.js";
import { PushLifecycle } from "../../src/push/authority.js";
import {
  deadlineCandidateSql,
  deadlineEventId,
  startDeadlineScheduler,
  type DeadlineTimer,
} from "../../src/push/deadlineScheduler.js";
import { PushService } from "../../src/push/service.js";
import type { IsolatedResolver } from "../../src/push/resolver.js";
import { testDb } from "../helpers.js";

const roots: string[] = [];
const keys = webPush.generateVAPIDKeys();
const auth = crypto.randomBytes(16).toString("base64url");
const endpoint = "https://push.example/deadline";
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const inertTimer: DeadlineTimer = { set: () => ({}), clear: () => {} };
const resolver = (): IsolatedResolver => ({
  resolve4: async () => ["8.8.8.8"],
  resolve6: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); },
  cancel() {},
});

describe("automatic deadline scheduler", () => {
  let database: Awaited<ReturnType<typeof testDb>>;
  let lifecycle: PushLifecycle;

  beforeEach(async () => {
    database = await testDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-deadline-scheduler-"));
    roots.push(root);
    lifecycle = new PushLifecycle({
      dataDir: root,
      deleteSubscriptions: () => database.prepare("DELETE FROM push_subscriptions").run(),
    });
    database.prepare("DELETE FROM deadline_reminder_claims").run();
    database.prepare("DELETE FROM push_subscriptions").run();
    database.prepare("DELETE FROM tasks").run();
    database.prepare("DELETE FROM goals").run();
    database.prepare("DELETE FROM categories").run();
    database.prepare("INSERT INTO categories(id,name,color,is_default) VALUES (1,'Project Alpha','#123456',1)").run();
    database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES (?,?,?,?,NULL,'device-created','device-seen')`,
    ).run(deviceId, endpoint, keys.publicKey, auth);
    database.prepare("UPDATE settings SET value='0' WHERE key='push_lead_days'").run();
    database.prepare("UPDATE settings SET value='09:00' WHERE key='push_send_time'").run();
    database.prepare("UPDATE settings SET value='UTC' WHERE key='push_timezone'").run();
    database.prepare("UPDATE settings SET value=NULL WHERE key IN ('push_quiet_start','push_quiet_end')").run();
    database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
  });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function task(values: { id?: number; title?: string; due?: string; status?: string; created?: string; extra?: string } = {}) {
    database.prepare(
      `INSERT INTO tasks(id,title,category_id,due_date,status,created_at,blocked,deferred_until,window_days,window_start,window_end)
       VALUES (?,?,?,?,?,?,1,'2099-01-01','[1]','23:00','23:15')`,
    ).run(values.id ?? 1, values.title ?? "Ship it", 1, values.due ?? "2026-09-20", values.status ?? "open", values.created ?? "task-created");
  }

  function service(overrides: Partial<ConstructorParameters<typeof PushService>[0]> = {}) {
    return new PushService({
      database: () => database,
      lifecycle,
      topology: { listenerHost: "127.0.0.1", listenerPort: 3001, trustProxy: false },
      resolverFactory: resolver,
      wallNow: () => Date.parse("2026-09-20T09:00:00Z"),
      generateRequestDetails: (_subscription, _payload, options) => ({
        endpoint, method: "POST", headers: { TTL: String(options.TTL), Topic: String(options.topic) }, body: Buffer.from("encrypted"),
      }),
      transport: { send: async () => "success" },
      ...overrides,
    });
  }

  it("claims before DNS, sends exact detailed metadata once, and deduplicates restart/fold-style repeats", async () => {
    task();
    const payloads: unknown[] = [];
    let dnsSawClaim = false;
    let sends = 0;
    const push = service({
      resolverFactory: () => ({
        ...resolver(),
        resolve4: async () => {
          dnsSawClaim = Boolean(database.prepare("SELECT 1 FROM deadline_reminder_claims").get());
          return ["8.8.8.8"];
        },
      }),
      observeDeadlinePayload: (payload) => payloads.push(JSON.parse(payload.toString("utf8"))),
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    scheduler.stop();
    const restarted = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await restarted.runNow();
    restarted.stop();

    const eventId = deadlineEventId("task", 1, "task-created", "2026-09-20");
    expect(eventId).toBe("r41tDOIz8WuOkY3PQY63fA");
    expect(dnsSawClaim).toBe(true);
    expect(sends).toBe(1);
    expect(payloads).toEqual([{
      v: 1, kind: "deadline", itemType: "task", itemId: 1, eventId,
      detail: "detailed", itemTitle: "Ship it", context: "Project Alpha", deadline: "2026-09-20",
    }]);
    expect(database.prepare("SELECT * FROM deadline_reminder_claims").all()).toHaveLength(1);
  });

  it("treats reused numeric ids with a new created_at as distinct occurrences", async () => {
    task();
    const ids: string[] = [];
    const push = service({ observeDeadlinePayload: (payload) => ids.push(
      (JSON.parse(payload.toString("utf8")) as { eventId: string }).eventId,
    ) });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    database.prepare("DELETE FROM tasks WHERE id=1").run();
    task({ id: 1, created: "reused-created-at", title: "Reused id" });
    await scheduler.runNow();
    expect(ids).toEqual([
      deadlineEventId("task", 1, "task-created", "2026-09-20"),
      deadlineEventId("task", 1, "reused-created-at", "2026-09-20"),
    ]);
    scheduler.stop();
  });

  it("keeps busy work unclaimed and retains claims after DNS failure with no retry", async () => {
    task();
    const busy = service({ admission: new PushAdmission(() => 0, { active: 4 }) });
    const busyScheduler = startDeadlineScheduler({ database: () => database, push: busy,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await busyScheduler.runNow();
    expect(database.prepare("SELECT * FROM deadline_reminder_claims").all()).toEqual([]);
    busyScheduler.stop();

    let resolutions = 0;
    const failing = service({ resolverFactory: () => ({
      resolve4: async () => { resolutions += 1; throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); },
      resolve6: async () => { resolutions += 1; throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); },
      cancel() {},
    }) });
    const scheduler = startDeadlineScheduler({ database: () => database, push: failing,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    const first = resolutions;
    await scheduler.runNow();
    expect(first).toBeGreaterThan(0);
    expect(resolutions).toBe(first);
    expect(database.prepare("SELECT * FROM deadline_reminder_claims").all()).toHaveLength(1);
    scheduler.stop();
  });

  it("retains one-attempt claims across provider failure, stop, and pre-init cancellation", async () => {
    task();
    const resetClaim = () => database.prepare("DELETE FROM deadline_reminder_claims").run();

    let providerCalls = 0;
    const providerFailure = startDeadlineScheduler({ database: () => database,
      push: service({ transport: { send: async () => { providerCalls += 1; return "failed"; } } }),
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await providerFailure.runNow();
    await providerFailure.runNow();
    expect(providerCalls).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });
    providerFailure.stop();

    resetClaim();
    let stopScheduler: ReturnType<typeof startDeadlineScheduler>;
    let stopSends = 0;
    const stoppedPush = service({
      resolverFactory: () => ({
        ...resolver(), resolve4: async () => {
          stopScheduler.stop();
          throw Object.assign(new Error("stopped"), { code: "ECANCELLED" });
        },
      }),
      transport: { send: async () => { stopSends += 1; return "success"; } },
    });
    stopScheduler = startDeadlineScheduler({ database: () => database, push: stoppedPush,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await stopScheduler.runNow();
    expect(stopSends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });

    resetClaim();
    let cancelledSends = 0;
    const cancelledPush = service({
      resolverFactory: () => ({ ...resolver(), resolve4: async () => {
        lifecycle.advanceWorkGeneration();
        return ["8.8.8.8"];
      } }),
      transport: { send: async () => { cancelledSends += 1; return "success"; } },
    });
    const cancelledScheduler = startDeadlineScheduler({ database: () => database, push: cancelledPush,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await cancelledScheduler.runNow();
    expect(cancelledSends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });
    cancelledScheduler.stop();
  });

  it("does not recall initiated provider work when stop races after request initiation", async () => {
    task();
    let scheduler: ReturnType<typeof startDeadlineScheduler>;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let initiated = 0;
    let signalAfterStop: boolean | undefined;
    const push = service({ transport: { send: async ({ signal }) => {
      initiated += 1;
      scheduler.stop();
      signalAfterStop = signal.aborted;
      await held;
      return "success";
    } } });
    scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    const run = scheduler.runNow();
    for (let spin = 0; spin < 20 && initiated === 0; spin++) await Promise.resolve();
    expect(initiated).toBe(1);
    expect(signalAfterStop).toBe(false);
    release();
    await run;
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });
  });

  it("bounds ordered admission at 256 examined, 32 claims, and four shared concurrent attempts", async () => {
    for (let id = 1; id <= 300; id++) task({ id, created: `created-${String(id).padStart(3, "0")}` });
    let active = 0;
    let peak = 0;
    let sends = 0;
    const push = service({ transport: { send: async () => {
      sends += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return "success";
    } } });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    expect({ sends, peak }).toEqual({ sends: 32, peak: 4 });
    const claims = database.prepare("SELECT item_id AS id FROM deadline_reminder_claims ORDER BY item_id").all() as { id: number }[];
    expect(claims.map(({ id }) => id)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 300 });
    scheduler.stop();
  });

  it("caps only eligible unclaimed occurrences and materializes before the bounded device join", async () => {
    const insertExpired = database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES (?,?,?,?,?,'expired-created','expired-seen')`,
    );
    for (let index = 0; index < 20; index++) {
      const suffix = String(index).padStart(2, "0");
      insertExpired.run(`00000000-0000-4000-8000-0000000000${suffix}`,
        `https://expired-${suffix}.example/deadline`, keys.publicKey, auth, Date.parse("2026-09-20T08:00:00Z"));
    }
    for (let id = 1; id <= 300; id++) {
      task({ id, due: id % 2 === 0 ? "2026-09-19" : `legacy-${id}`, created: `stale-${id}` });
    }
    task({ id: 301, title: "Current task" });
    database.prepare(
      "INSERT INTO goals(id,title,target_date,status,created_at) VALUES (1,'Current goal','2026-09-20','active','goal-current')",
    ).run();
    database.prepare(
      "INSERT INTO goals(id,title,target_date,status,created_at) VALUES (2,'Past goal','2026-09-19','active','goal-past')",
    ).run();
    database.prepare(
      "INSERT INTO goals(id,title,target_date,status,created_at) VALUES (3,'Malformed goal','not-a-date','active','goal-bad')",
    ).run();

    const attempted: string[] = [];
    const push = service({ observeDeadlinePayload: (payload) => {
      const value = JSON.parse(payload.toString("utf8")) as { itemType: string; itemId: number };
      attempted.push(`${value.itemType}:${value.itemId}`);
    } });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    expect(attempted).toEqual(["goal:1", "task:301"]);

    const explain = database.prepare(`EXPLAIN QUERY PLAN ${deadlineCandidateSql(1)}`)
      .all("2026-09-20", "2026-09-20T09:00", Date.parse("2026-09-20T09:00:00Z")) as { detail: string }[];
    const details = explain.map(({ detail }) => detail).join("\n");
    expect(details).toContain("MATERIALIZE eligible_devices");
    expect(details).toContain("MATERIALIZE eligible_entities");
    expect(deadlineCandidateSql(1)).toMatch(/eligible_entities[\s\S]*LIMIT 256[\s\S]*CROSS JOIN eligible_devices/);
    expect(deadlineCandidateSql(1)).toMatch(/eligible_devices[\s\S]*LIMIT 16/);
    scheduler.stop();
  });

  it("does not let already-claimed eligible entities consume the 256 examination cap", async () => {
    const insertClaim = database.prepare(
      `INSERT INTO deadline_reminder_claims(device_id,item_type,item_id,item_created_at,deadline)
       VALUES (?,'task',?,?,'2026-09-20')`,
    );
    for (let id = 1; id <= 257; id++) {
      task({ id, created: `claimed-${String(id).padStart(3, "0")}` });
      if (id <= 256) insertClaim.run(deviceId, id, `claimed-${String(id).padStart(3, "0")}`);
    }
    const attempted: number[] = [];
    const scheduler = startDeadlineScheduler({ database: () => database,
      push: service({ observeDeadlinePayload: (payload) => attempted.push((JSON.parse(payload.toString("utf8")) as { itemId: number }).itemId) }),
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    expect(attempted).toEqual([257]);
    scheduler.stop();
  });

  it("rechecks completion, deadline, subscription, privacy, and authority after DNS", async () => {
    const mutations: Array<() => void> = [
      () => database.prepare("UPDATE tasks SET status='done' WHERE id=1").run(),
      () => database.prepare("UPDATE tasks SET due_date='2026-09-21' WHERE id=1").run(),
      () => database.prepare("UPDATE tasks SET created_at='reused-id' WHERE id=1").run(),
      () => database.prepare("DELETE FROM tasks WHERE id=1").run(),
      () => database.prepare("DELETE FROM push_subscriptions WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET last_seen_at='changed' WHERE id=?").run(deviceId),
      () => database.prepare("UPDATE push_subscriptions SET expiration_time=? WHERE id=?").run(Date.parse("2026-09-20T08:00:00Z"), deviceId),
      () => database.prepare("UPDATE settings SET value='1' WHERE key='push_hide_details'").run(),
      () => lifecycle.advanceWorkGeneration(),
    ];
    for (const mutate of mutations) {
      database.prepare("DELETE FROM deadline_reminder_claims").run();
      database.prepare("DELETE FROM push_subscriptions").run();
      database.prepare("DELETE FROM tasks").run();
      database.prepare(
        `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
         VALUES (?,?,?,?,NULL,'device-created','device-seen')`,
      ).run(deviceId, endpoint, keys.publicKey, auth);
      database.prepare("UPDATE settings SET value='0' WHERE key='push_hide_details'").run();
      task();
      let sends = 0;
      const push = service({ resolverFactory: () => ({
        ...resolver(), resolve4: async () => { mutate(); return ["8.8.8.8"]; },
      }), transport: { send: async () => { sends += 1; return "success"; } } });
      const scheduler = startDeadlineScheduler({ database: () => database, push,
        now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
      await scheduler.runNow();
      expect(sends).toBe(0);
      scheduler.stop();
    }
  });

  it("does no DNS when OR IGNORE loses or source state mutates between candidate read and claim", async () => {
    task();
    let dns = 0;
    const losing = service({ resolverFactory: () => ({
      ...resolver(), resolve4: async () => { dns += 1; return ["8.8.8.8"]; },
    }) });
    const originalLosingAcquire = losing.tryAcquireDeadline.bind(losing);
    vi.spyOn(losing, "tryAcquireDeadline").mockImplementationOnce(() => {
      database.prepare(
        `INSERT INTO deadline_reminder_claims(device_id,item_type,item_id,item_created_at,deadline)
         VALUES (?,'task',1,'task-created','2026-09-20')`,
      ).run(deviceId);
      return originalLosingAcquire();
    });
    const losingScheduler = startDeadlineScheduler({ database: () => database, push: losing,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await losingScheduler.runNow();
    expect(dns).toBe(0);
    losingScheduler.stop();

    database.prepare("DELETE FROM deadline_reminder_claims").run();
    const mutated = service({ resolverFactory: () => ({
      ...resolver(), resolve4: async () => { dns += 1; return ["8.8.8.8"]; },
    }) });
    const originalMutatedAcquire = mutated.tryAcquireDeadline.bind(mutated);
    vi.spyOn(mutated, "tryAcquireDeadline").mockImplementationOnce(() => {
      database.prepare("UPDATE tasks SET status='done' WHERE id=1").run();
      return originalMutatedAcquire();
    });
    const mutatedScheduler = startDeadlineScheduler({ database: () => database, push: mutated,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await mutatedScheduler.runNow();
    expect(dns).toBe(0);
    expect(database.prepare("SELECT * FROM deadline_reminder_claims").all()).toEqual([]);
    mutatedScheduler.stop();

    database.prepare("UPDATE tasks SET status='open' WHERE id=1").run();
    let dnsInTransaction: boolean | undefined;
    const normal = service({ resolverFactory: () => ({
      ...resolver(), resolve4: async () => {
        dnsInTransaction = database.inTransaction;
        return ["8.8.8.8"];
      },
    }) });
    const normalScheduler = startDeadlineScheduler({ database: () => database, push: normal,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await normalScheduler.runNow();
    expect(dnsInTransaction).toBe(false);
    normalScheduler.stop();
  });

  it("recomputes unclaimed occurrences from current lead and timezone settings", async () => {
    task({ due: "2026-09-21" });
    database.prepare("UPDATE settings SET value='0' WHERE key='push_lead_days'").run();
    let instant = new Date("2026-09-20T09:00:00Z");
    let sends = 0;
    const scheduler = startDeadlineScheduler({ database: () => database,
      push: service({ transport: { send: async () => { sends += 1; return "success"; } } }),
      now: () => instant, timer: inertTimer });
    await scheduler.runNow();
    expect(sends).toBe(0);
    database.prepare("UPDATE settings SET value='1' WHERE key='push_lead_days'").run();
    await scheduler.runNow();
    expect(sends).toBe(1);

    database.prepare("DELETE FROM deadline_reminder_claims").run();
    database.prepare("UPDATE tasks SET due_date='2026-09-20' WHERE id=1").run();
    database.prepare("UPDATE settings SET value='0' WHERE key='push_lead_days'").run();
    database.prepare("UPDATE settings SET value='UTC' WHERE key='push_timezone'").run();
    instant = new Date("2026-09-20T08:30:00Z");
    await scheduler.runNow();
    expect(sends).toBe(1);
    database.prepare("UPDATE settings SET value='Europe/Berlin' WHERE key='push_timezone'").run();
    await scheduler.runNow();
    expect(sends).toBe(2);
    scheduler.stop();
  });

  it("does not cancel a claimed attempt for timing-only edits and conditionally deletes only an unchanged gone subscription", async () => {
    task();
    let sends = 0;
    const timingEdit = service({
      resolverFactory: () => ({ ...resolver(), resolve4: async () => {
        database.prepare("UPDATE settings SET value='10:00' WHERE key='push_send_time'").run();
        return ["8.8.8.8"];
      } }),
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const timingScheduler = startDeadlineScheduler({ database: () => database, push: timingEdit,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await timingScheduler.runNow();
    expect(sends).toBe(1);
    timingScheduler.stop();

    database.prepare("DELETE FROM deadline_reminder_claims").run();
    database.prepare("UPDATE settings SET value='09:00' WHERE key='push_send_time'").run();
    const lateGone = service({ transport: { send: async () => {
      database.prepare("UPDATE push_subscriptions SET last_seen_at='new-registration' WHERE id=?").run(deviceId);
      return "gone";
    } } });
    const lateScheduler = startDeadlineScheduler({ database: () => database, push: lateGone,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await lateScheduler.runNow();
    expect(database.prepare("SELECT last_seen_at FROM push_subscriptions WHERE id=?").get(deviceId))
      .toEqual({ last_seen_at: "new-registration" });
    lateScheduler.stop();

    database.prepare("DELETE FROM deadline_reminder_claims").run();
    const gone = service({ transport: { send: async () => "gone" } });
    const goneScheduler = startDeadlineScheduler({ database: () => database, push: gone,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await goneScheduler.runNow();
    expect(database.prepare("SELECT id FROM push_subscriptions WHERE id=?").get(deviceId)).toBeUndefined();
    goneScheduler.stop();
  });

  it("uses generic privacy and oversize fallback without truncation or a second provider request", async () => {
    task({ title: "🚀".repeat(2_000) });
    const clear: Buffer[] = [];
    let generated = 0;
    let sends = 0;
    const push = service({
      generateRequestDetails: (_subscription, payload, options) => {
        generated += 1;
        clear.push(Buffer.from(payload));
        return { endpoint, method: "POST", headers: { Topic: String(options.topic), TTL: String(options.TTL) }, body: Buffer.from("encrypted") };
      },
      transport: { send: async ({ details }) => {
        sends += 1;
        expect(details.headers).toMatchObject({ TTL: "0" });
        return "success";
      } },
    });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    expect(generated).toBe(1);
    expect(sends).toBe(1);
    const body = JSON.parse(clear[0].toString("utf8"));
    expect(body).toMatchObject({ detail: "generic", kind: "deadline", itemType: "task", itemId: 1 });
    expect(JSON.stringify(body)).not.toContain("🚀");
    scheduler.stop();
  });

  it("falls back after an encrypted detailed bound and sends nothing when generic generation fails", async () => {
    task();
    const generated: string[] = [];
    let sends = 0;
    const fallback = service({
      generateRequestDetails: (_subscription, payload, options) => {
        const value = JSON.parse(payload.toString("utf8")) as { detail: string };
        generated.push(value.detail);
        return {
          endpoint, method: "POST", headers: { Topic: String(options.topic), TTL: String(options.TTL) },
          body: Buffer.alloc(value.detail === "detailed" ? 4_097 : 128),
        };
      },
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const fallbackScheduler = startDeadlineScheduler({ database: () => database, push: fallback,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await fallbackScheduler.runNow();
    expect(generated).toEqual(["detailed", "generic"]);
    expect(sends).toBe(1);
    fallbackScheduler.stop();

    database.prepare("DELETE FROM deadline_reminder_claims").run();
    generated.length = 0;
    sends = 0;
    const failedGeneric = service({
      generateRequestDetails: (_subscription, payload) => {
        const value = JSON.parse(payload.toString("utf8")) as { detail: string };
        generated.push(value.detail);
        if (value.detail === "generic") throw new Error("synthetic generic generation failure");
        return { endpoint, method: "POST", headers: {}, body: Buffer.alloc(4_097) };
      },
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const failedScheduler = startDeadlineScheduler({ database: () => database, push: failedGeneric,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await failedScheduler.runNow();
    expect(generated).toEqual(["detailed", "generic"]);
    expect(sends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });
    failedScheduler.stop();
  });

  it("includes active goals with null context and excludes resolved, malformed, or overdue sources", async () => {
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (1,'Goal','2026-09-20','active','goal-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (2,'Done goal','2026-09-20','achieved','done-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (3,'Missed goal','2026-09-20','missed','missed-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (4,'Dropped goal','2026-09-20','dropped','dropped-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (5,'Overdue goal','2026-09-19','active','overdue-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (6,'Malformed goal','legacy-date','active','malformed-created')").run();
    task({ id: 1, due: "2026-09-19" });
    task({ id: 2, due: "legacy-impossible", created: "bad-created" });
    task({ id: 3, title: "Sequential parent" });
    task({ id: 4, title: "Held leaf" });
    database.prepare("UPDATE tasks SET subtask_order_mode='sequential' WHERE id=3").run();
    database.prepare("UPDATE tasks SET parent_id=3 WHERE id=4").run();
    task({ id: 5, status: "done" });
    task({ id: 6, status: "archived" });
    const payloads: Record<string, unknown>[] = [];
    const push = service({ observeDeadlinePayload: (payload) => payloads.push(JSON.parse(payload.toString("utf8"))) });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    expect(payloads).toHaveLength(3);
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemType: "goal", itemId: 1, detail: "detailed", context: null, deadline: "2026-09-20" }),
      expect.objectContaining({ itemType: "task", itemId: 3, itemTitle: "Sequential parent" }),
      expect.objectContaining({ itemType: "task", itemId: 4, itemTitle: "Held leaf" }),
    ]));
    scheduler.stop();
  });

  it("retains edit/revert claims, treats an advanced recurrence date as new, and prunes at most 500", async () => {
    database.prepare("UPDATE settings SET value='1' WHERE key='push_lead_days'").run();
    task();
    let sends = 0;
    const push = service({ transport: { send: async () => { sends += 1; return "success"; } } });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    await scheduler.runNow();
    database.prepare("UPDATE tasks SET due_date='2026-09-21' WHERE id=1").run();
    await scheduler.runNow();
    database.prepare("UPDATE tasks SET due_date='2026-09-20' WHERE id=1").run();
    await scheduler.runNow();
    expect(sends).toBe(2);
    expect(database.prepare("SELECT deadline FROM deadline_reminder_claims ORDER BY deadline").all())
      .toEqual([{ deadline: "2026-09-20" }, { deadline: "2026-09-21" }]);

    database.prepare("DELETE FROM tasks").run();
    database.prepare("DELETE FROM deadline_reminder_claims").run();
    const insert = database.prepare(
      "INSERT INTO deadline_reminder_claims(device_id,item_type,item_id,item_created_at,deadline) VALUES (?,'task',?,?,'2026-09-19')",
    );
    database.transaction(() => {
      for (let id = 1; id <= 600; id++) insert.run(deviceId, id, `orphan-${id}`);
    })();
    await scheduler.runNow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 100 });
    scheduler.stop();
  });

  it("recursively continues after a redacted tick failure without overlapping runs", async () => {
    task();
    const callbacks: Array<() => void> = [];
    const timer: DeadlineTimer = {
      set: (callback) => { callbacks.push(callback); return {}; },
      clear: vi.fn(),
    };
    const logs: string[] = [];
    let databaseReads = 0;
    let sends = 0;
    const scheduler = startDeadlineScheduler({
      database: () => {
        databaseReads += 1;
        if (databaseReads === 1) throw new Error("sensitive synthetic failure");
        return database;
      },
      push: service({ transport: { send: async () => { sends += 1; return "success"; } } }),
      now: () => new Date("2026-09-20T09:00:00Z"),
      timer,
      log: (message) => logs.push(message),
    });
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toEqual(["[push] deadline tick failed (redacted)"]);
    expect(logs.join(" ")).not.toContain("sensitive");
    expect(callbacks).toHaveLength(1);

    callbacks.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toBe(1);
    expect(callbacks).toHaveLength(1);
    scheduler.stop();
  });

  it("makes stop idempotent, prevents overlap, and holds scheduled admission until initiated work settles", async () => {
    task();
    const callbacks: Array<() => void> = [];
    const clear = vi.fn();
    const timer: DeadlineTimer = {
      set: (callback) => { callbacks.push(callback); return {}; },
      clear,
    };
    const admission = new PushAdmission(() => 0);
    let initiated = 0;
    let settle!: () => void;
    const held = new Promise<void>((resolve) => { settle = resolve; });
    const scheduler = startDeadlineScheduler({ database: () => database,
      push: service({ admission, transport: { send: async () => {
        initiated += 1;
        await held;
        return "success";
      } } }),
      now: () => new Date("2026-09-20T09:00:00Z"), timer });
    callbacks.shift()!();
    for (let spin = 0; spin < 20 && initiated === 0; spin++) await Promise.resolve();
    expect(initiated).toBe(1);
    expect(admission.snapshot().active).toBe(1);
    await scheduler.runNow();
    expect(initiated).toBe(1);
    scheduler.stop();
    scheduler.stop();
    expect(admission.snapshot().active).toBe(1);
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admission.snapshot().active).toBe(0);
    expect(callbacks).toEqual([]);
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps unavailable, timezone-unset, and device-free ticks inert before claims or outbound work", async () => {
    const prepare = vi.spyOn(database, "prepare");
    let dns = 0;
    let generated = 0;
    let sends = 0;
    const push = service({
      resolverFactory: () => ({ ...resolver(), resolve4: async () => { dns += 1; return ["8.8.8.8"]; } }),
      generateRequestDetails: () => {
        generated += 1;
        return { endpoint, method: "POST", headers: {}, body: Buffer.from("encrypted") };
      },
      transport: { send: async () => { sends += 1; return "success"; } },
    });
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });

    lifecycle.invalidate();
    const beforeUnavailable = prepare.mock.calls.length;
    await scheduler.runNow();
    expect(prepare.mock.calls.length).toBe(beforeUnavailable);

    lifecycle.reset();
    database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES (?,?,?,?,NULL,'device-created','device-seen')`,
    ).run(deviceId, endpoint, keys.publicKey, auth);
    database.prepare("UPDATE settings SET value=NULL WHERE key='push_timezone'").run();
    await scheduler.runNow();
    expect(database.prepare("SELECT * FROM deadline_reminder_claims").all()).toEqual([]);

    database.prepare("UPDATE settings SET value='UTC' WHERE key='push_timezone'").run();
    database.prepare("DELETE FROM push_subscriptions").run();
    await scheduler.runNow();
    expect({ dns, generated, sends }).toEqual({ dns: 0, generated: 0, sends: 0 });
    scheduler.stop();
  });
});
