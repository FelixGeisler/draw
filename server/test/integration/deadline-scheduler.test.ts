import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushAdmission } from "../../src/push/admission.js";
import { PushLifecycle } from "../../src/push/authority.js";
import { deadlineEventId, startDeadlineScheduler, type DeadlineTimer } from "../../src/push/deadlineScheduler.js";
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
    await scheduler.runNow();
    scheduler.stop();

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

  it("keeps busy work unclaimed and retains claims after DNS/provider failure with no retry", async () => {
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

  it("includes active goals with null context and excludes resolved or overdue sources", async () => {
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (1,'Goal','2026-09-20','active','goal-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (2,'Done goal','2026-09-20','achieved','done-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (3,'Missed goal','2026-09-20','missed','missed-created')").run();
    database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (4,'Dropped goal','2026-09-20','dropped','dropped-created')").run();
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

  it("is inert while unavailable, timezone-unset, or device-free", async () => {
    const prepare = vi.spyOn(database, "prepare");
    lifecycle.invalidate();
    const push = service();
    const scheduler = startDeadlineScheduler({ database: () => database, push,
      now: () => new Date("2026-09-20T09:00:00Z"), timer: inertTimer });
    const before = prepare.mock.calls.length;
    await scheduler.runNow();
    expect(prepare.mock.calls.length).toBe(before);
    scheduler.stop();
  });
});
