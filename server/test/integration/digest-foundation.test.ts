import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import { isCalendarDate } from "../../src/services/taskWrites.js";

let app: express.Express;
let database: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  database = await testDb();
});

const TIMING_PRIVACY_KEYS = [
  "push_hide_details", "push_send_time", "push_timezone", "push_quiet_start", "push_quiet_end",
] as const;

describe("daily digest persistence foundation", () => {
  it("keeps all timing/privacy fields out of generic Settings", async () => {
    const settings = (await request(app).get("/api/settings").expect(200)).body as Record<string, unknown>;
    for (const key of TIMING_PRIVACY_KEYS) expect(settings).not.toHaveProperty(key);
    expect(settings).not.toHaveProperty("push_lead_days");
  });

  it("cascades device/date claims only with subscription lifecycle", () => {
    database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES ('device-a','https://a.invalid','p','a',NULL,'c','s'),
              ('device-b','https://b.invalid','p','a',NULL,'c','s')`,
    ).run();
    database.prepare(
      `INSERT INTO daily_digest_claims(device_id,local_date)
       VALUES ('device-a','2026-09-20'),('device-b','2026-09-20')`,
    ).run();
    database.prepare("DELETE FROM push_subscriptions WHERE id='device-a'").run();
    expect(database.prepare("SELECT * FROM daily_digest_claims").all())
      .toEqual([{ device_id: "device-b", local_date: "2026-09-20" }]);
    database.prepare("DELETE FROM push_subscriptions").run();
  });

  it("task/goal deletion does not alter retained device/date history", async () => {
    database.prepare(
      `INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at)
       VALUES ('device-retained','https://retained.invalid','p','a',NULL,'c','s')`,
    ).run();
    database.prepare("INSERT INTO daily_digest_claims VALUES ('device-retained','2026-09-20')").run();
    const task = (await request(app).post("/api/tasks").send({ title: "remove", categoryId: 1 }).expect(201)).body;
    const goal = (await request(app).post("/api/goals").send({ title: "remove" }).expect(201)).body;
    await request(app).delete(`/api/tasks/${task.id}`).expect(200);
    await request(app).delete(`/api/goals/${goal.id}`).expect(200);
    expect(database.prepare("SELECT * FROM daily_digest_claims").all()).toHaveLength(1);
    database.prepare("DELETE FROM push_subscriptions").run();
  });
});

describe("shared Gregorian date validation", () => {
  it.each(["0001-01-01", "2000-02-29", "9999-12-31"])("accepts %s", (date) => {
    expect(isCalendarDate(date)).toBe(true);
  });
  it.each(["0000-01-01", "1900-02-29", "2026-02-30", "2026-1-01"])("rejects %s", (date) => {
    expect(isCalendarDate(date)).toBe(false);
  });
});
