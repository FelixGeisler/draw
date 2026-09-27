import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let db: Awaited<ReturnType<typeof testDb>>;
const IDS = Array.from({ length: 20 }, (_, index) => 9300 + index);

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

afterEach(() => {
  vi.useRealTimers();
  // Failure-safe isolation: rows are removed even when an assertion throws.
  db.prepare(`DELETE FROM tasks WHERE id BETWEEN 9300 AND 9399`).run();
  db.prepare(`DELETE FROM goals WHERE id BETWEEN 9300 AND 9399`).run();
});

function seedTask(id: number, title: string, date: string | null, status = "open", parentId: number | null = null) {
  db.prepare(`INSERT INTO tasks (id,title,category_id,parent_id,due_date,status,created_at)
              VALUES (?,?,1,?,?,?,?)`).run(id, title, parentId, date, status, `2026-01-01T00:00:${id % 60}.000Z`);
}

function seedGoal(id: number, title: string, date: string | null, status = "active") {
  db.prepare(`INSERT INTO goals (id,title,target_date,status,created_at) VALUES (?,?,?,?,?)`)
    .run(id, title, date, status, `2026-01-01T00:00:${id % 60}.000Z`);
}

describe("GET /api/daily-overview", () => {
  it("returns the exact complete read-only projection with no five-row cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
    for (let index = 0; index < 7; index++) seedTask(IDS[index], `Today ${index}`, "2026-09-27");
    seedGoal(IDS[7], "Older goal", "2026-09-20");
    seedTask(IDS[8], "After tomorrow", "2026-09-29");
    seedTask(IDS[9], "Malformed", "2026-02-30");
    const before = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;

    const response = await request(app).get("/api/daily-overview?timezone=Europe%2FBerlin").expect(200);
    expect(Object.keys(response.body)).toEqual(["timezone", "localDate", "counts", "groups"]);
    expect(response.body.timezone).toBe("Europe/Berlin");
    expect(response.body.localDate).toBe("2026-09-27");
    expect(response.body.counts).toEqual({ overdue: 1, today: 7, tomorrow: 0 });
    expect(response.body.groups.today).toHaveLength(7);
    expect(Object.keys(response.body.groups.today[0])).toEqual(["type", "id", "title", "date"]);
    expect(response.body.counts.today).toBe(response.body.groups.today.length);
    const after = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    expect(after).toBe(before);
  });

  it("uses the accepted zone at one frozen instant for distinct dates and classifications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:30:00.000Z"));
    seedTask(IDS[0], "New year boundary", "2026-01-02");

    const east = await request(app).get("/api/daily-overview?timezone=Pacific%2FKiritimati").expect(200);
    const west = await request(app).get("/api/daily-overview?timezone=Pacific%2FPago_Pago").expect(200);
    expect(east.body.localDate).toBe("2026-01-02");
    expect(east.body.groups.today.map((item: { title: string }) => item.title)).toContain("New year boundary");
    expect(west.body.localDate).toBe("2025-12-31");
    expect(west.body.groups.tomorrow.map((item: { title: string }) => item.title)).not.toContain("New year boundary");
  });

  it("rejects every invalid timezone class with one exact 400 and no write", async () => {
    const invalid = [
      "/api/daily-overview",
      "/api/daily-overview?timezone=",
      "/api/daily-overview?timezone=UTC&timezone=Europe%2FBerlin",
      "/api/daily-overview?timezone[]=UTC",
      "/api/daily-overview?timezone=%20UTC",
      `/api/daily-overview?timezone=${"A".repeat(129)}`,
      "/api/daily-overview?timezone=Europ%C3%A9%2FBerlin",
      "/api/daily-overview?timezone=Not%2FA_Zone",
    ];
    const before = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    for (const url of invalid) {
      const response = await request(app).get(url).expect(400);
      expect(response.body, url).toEqual({ error: "invalid timezone" });
    }
    const after = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    expect(after).toBe(before);
  });

  it("keeps the endpoint behind the password gate", async () => {
    const { createApp } = await import("../../src/app.js");
    const protectedApp = createApp({ password: "daily-secret" });
    await request(protectedApp).get("/api/daily-overview?timezone=UTC").expect(401);
    await request(protectedApp)
      .get("/api/daily-overview?timezone=UTC")
      .set("x-draw-password", "daily-secret")
      .expect(200);
  });
});

describe("all-status focus loading", () => {
  it("returns an archived root with its non-archived open child", async () => {
    seedTask(IDS[0], "Archived root", "2026-09-27", "archived");
    seedTask(IDS[1], "Open child", "2026-09-27", "open", IDS[0]);
    const response = await request(app).get("/api/tasks?status=all").expect(200);
    const root = response.body.find((task: { id: number }) => task.id === IDS[0]);
    expect(root.status).toBe("archived");
    expect(root.subtasks).toEqual([expect.objectContaining({ id: IDS[1], status: "open" })]);
  });
});
