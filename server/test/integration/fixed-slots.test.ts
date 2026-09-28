import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { freshApp, testDb } from "../helpers.js";
import { executeTool, type ApiClient } from "../../src/tools/catalog.js";
import { createBackupArchive, runScheduledBackup } from "../../src/services/backupService.js";
import { validateV22Contract } from "../../src/schemaV22.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

const utcSlot = {
  startLocal: "2026-10-20T10:00",
  endLocal: "2026-10-20T11:00",
  entryTimezone: "UTC",
};

async function create(title: string, extra: Record<string, unknown> = {}) {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, effortMinutes: 10, ...extra })
      .expect(201)
  ).body;
}

describe("fixed-slot REST contract", () => {
  it("creates, replaces and clears one slot without changing deadline, availability or work", async () => {
    const task = await create("Anchored appointment", {
      dueDate: "2026-11-30",
      windowDays: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
      fixedSlot: utcSlot,
    });
    expect(task).toMatchObject({
      hasFixedSlot: true,
      dueDate: "2026-11-30",
      windowDays: [1, 2, 3, 4, 5],
      fixedSlot: {
        ...utcSlot,
        startsAt: "2026-10-20T10:00:00.000Z",
        endsAt: "2026-10-20T11:00:00.000Z",
        startOffsetSeconds: 0,
        endOffsetSeconds: 0,
      },
    });

    const replaced = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Anchored appointment moved",
        fixedSlot: {
          startLocal: "2026-10-25T02:30",
          endLocal: "2026-10-25T03:30",
          entryTimezone: "Europe/Berlin",
        },
      })
      .expect(200);
    expect(replaced.body.task).toMatchObject({
      title: "Anchored appointment moved",
      dueDate: "2026-11-30",
      windowDays: [1, 2, 3, 4, 5],
      fixedSlot: {
        startLocal: "2026-10-25T02:30",
        endLocal: "2026-10-25T03:30",
        entryTimezone: "Europe/Berlin",
        startsAt: "2026-10-25T00:30:00.000Z",
        endsAt: "2026-10-25T02:30:00.000Z",
        startOffsetSeconds: 7200,
        endOffsetSeconds: 3600,
      },
    });

    const database = await testDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE task_id=?").get(task.id)).toEqual({ n: 0 });
    const cleared = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ fixedSlot: null })
      .expect(200);
    expect(cleared.body.task).toMatchObject({
      hasFixedSlot: false,
      fixedSlot: null,
      dueDate: "2026-11-30",
      windowDays: [1, 2, 3, 4, 5],
    });
    // Clear is explicitly idempotent.
    await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: null }).expect(200);
  });

  it("rejects malformed temporal input, output fields and missing tasks with no partial write", async () => {
    const badInputs: unknown[] = [
      {},
      [],
      "slot",
      { startLocal: "2026-10-20T10:00", endLocal: "2026-10-20T11:00" },
      { ...utcSlot, extra: true },
      { ...utcSlot, startLocal: "2026-10-20T10:00:00" },
      { ...utcSlot, startLocal: "2026-10-20T10:00Z" },
      { ...utcSlot, entryTimezone: "US/Eastern" },
      { ...utcSlot, entryTimezone: "Etc/GMT+1" },
      { ...utcSlot, startLocal: "2026-10-20T12:00" },
    ];
    for (const fixedSlot of badInputs) {
      await request(app)
        .post("/api/tasks")
        .send({ title: "Must not exist", categoryId: 1, dueDate: "2026-12-01", fixedSlot })
        .expect(400);
    }
    await request(app)
      .post("/api/tasks")
      .send({ title: "No forged instant", categoryId: 1, startsAt: "2026-01-01T00:00:00.000Z" })
      .expect(400);
    await request(app).patch("/api/tasks/999999").send({ fixedSlot: utcSlot }).expect(404);
    const database = await testDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='Must not exist'").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots").get()).toMatchObject({ n: expect.any(Number) });
  });

  it("enforces the final fixed-plus-recurrence state atomically", async () => {
    const recurring = await create("Laundry", { dueDate: "2026-10-20", recurEveryDays: 7 });
    const conflict = await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ title: "Must roll back", fixedSlot: utcSlot })
      .expect(400);
    expect(conflict.body.error).toContain("cannot have both");
    let listed = (await request(app).get("/api/tasks").expect(200)).body.find(
      (task: { id: number }) => task.id === recurring.id,
    );
    expect(listed).toMatchObject({ title: "Laundry", recurEveryDays: 7, fixedSlot: null });

    const fixed = await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ recurEveryDays: null, fixedSlot: utcSlot })
      .expect(200);
    expect(fixed.body.task).toMatchObject({ recurEveryDays: null, hasFixedSlot: true });

    await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ title: "Unrelated edit", recurEveryDays: 2 })
      .expect(400);
    listed = (await request(app).get("/api/tasks").expect(200)).body.find(
      (task: { id: number }) => task.id === recurring.id,
    );
    expect(listed).toMatchObject({ title: "Laundry", recurEveryDays: null, hasFixedSlot: true });

    const recurringAgain = await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ fixedSlot: null, recurEveryDays: 2 })
      .expect(200);
    expect(recurringAgain.body.task).toMatchObject({ fixedSlot: null, recurEveryDays: 2 });
  });

  it("rejects fixed-slot combinations with completion/reopen and split", async () => {
    const root = await create("Fixed lifecycle", { fixedSlot: utcSlot });
    await request(app)
      .patch(`/api/tasks/${root.id}`)
      .send({ status: "done", fixedSlot: null })
      .expect(400);
    await request(app).patch(`/api/tasks/${root.id}`).send({ status: "done" }).expect(200);
    await request(app)
      .patch(`/api/tasks/${root.id}`)
      .send({ status: "open", fixedSlot: null })
      .expect(400);
    await request(app).patch(`/api/tasks/${root.id}`).send({ status: "open" }).expect(200);

    const parent = await create("Parent");
    const child = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Fixed step", categoryId: 1, parentId: parent.id, effortMinutes: 10, fixedSlot: utcSlot })
        .expect(201)
    ).body;
    await request(app)
      .post(`/api/tasks/${child.id}/split`)
      .send({ parts: [{ title: "A", effortMinutes: 5 }, { title: "B", effortMinutes: 5 }] })
      .expect(400);
    const row = (await testDb()).prepare("SELECT status FROM tasks WHERE id=?").get(child.id);
    expect(row).toEqual({ status: "open" });
  });
});

describe("phase-1A automation boundaries", () => {
  it("rejects MCP slot/resolved input while ordinary MCP edits preserve and enforce slots", async () => {
    const task = await create("MCP preserves appointment", { fixedSlot: utcSlot });
    const api: ApiClient = {
      async request(method, url, body) {
        const call = request(app)[method.toLowerCase() as "get" | "post" | "patch"](url);
        const response = body === undefined ? await call : await call.send(body as string | object);
        return { status: response.status, body: response.body };
      },
    };

    const unknown = await executeTool("update_task", api, { id: task.id, fixedSlot: null });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Unrecognized key");
    const resolved = await executeTool("create_task", api, {
      title: "Forged",
      categoryId: 1,
      startsAt: "2026-01-01T00:00:00.000Z",
    });
    expect(resolved.isError).toBe(true);

    const ordinary = await executeTool("update_task", api, {
      id: task.id,
      title: "MCP ordinary edit",
    });
    expect(ordinary.isError).not.toBe(true);
    const conflict = await executeTool("update_task", api, {
      id: task.id,
      title: "Must not commit",
      recurEveryDays: 3,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("cannot have both");

    const listed = (await request(app).get("/api/tasks").expect(200)).body.find(
      (candidate: { id: number }) => candidate.id === task.id,
    );
    expect(listed).toMatchObject({
      title: "MCP ordinary edit",
      hasFixedSlot: true,
      recurEveryDays: null,
    });
  });

  it("rejects reviewed-assistant slot fields instead of stripping them", async () => {
    const response = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          {
            kind: "create_task",
            draftId: "draft-1",
            task: {
              title: "Assistant forged slot",
              categoryId: 1,
              fixedSlot: utcSlot,
            },
          },
        ],
      })
      .expect(400);
    expect(response.body.error).toMatch(/fixedSlot|Unrecognized key/);
    const database = await testDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='Assistant forged slot'").get()).toEqual({ n: 0 });
  });
});

describe("fixed-slot Draw, timer and lifecycle behavior", () => {
  it("excludes before/during/after, clears a revealed card atomically, and clear restores eligibility", async () => {
    const database = await testDb();
    database.prepare("UPDATE tasks SET status='archived' WHERE status='open'").run();
    database.prepare("DELETE FROM settings WHERE key IN ('current_draw_task_id','warmup_current_draw','warmup_last_dealt')").run();
    const drawable = await create("Reveal then schedule");
    const dealt = await request(app).post("/api/draw").send({}).expect(200);
    expect(dealt.body.task.id).toBe(drawable.id);
    expect((await request(app).get("/api/draw/current").expect(200)).body.task.id).toBe(drawable.id);

    await request(app).patch(`/api/tasks/${drawable.id}`).send({ fixedSlot: utcSlot }).expect(200);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([]);
    expect((await request(app).post("/api/draw/warmup").send({}).expect(200)).body.task).toBeNull();
    await request(app)
      .patch(`/api/tasks/${drawable.id}`)
      .send({
        fixedSlot: {
          startLocal: "2001-01-01T10:00",
          endLocal: "2001-01-01T11:00",
          entryTimezone: "UTC",
        },
      })
      .expect(200);
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([]);

    await request(app).patch(`/api/tasks/${drawable.id}`).send({ fixedSlot: null }).expect(200);
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([
      expect.objectContaining({ id: drawable.id }),
    ]);
  });

  it("serializes competing recurrence, slot, candidate and restore operations through the real service", async () => {
    const database = await testDb();
    database.prepare("UPDATE tasks SET status='archived' WHERE status='open'").run();
    database.prepare("DELETE FROM settings WHERE key IN ('current_draw_task_id','warmup_current_draw')").run();
    const task = await create("Concurrent invariant contender");

    const contenders = await Promise.all([
      request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: utcSlot }),
      request(app).patch(`/api/tasks/${task.id}`).send({ recurEveryDays: 2 }),
    ]);
    expect(contenders.map((response) => response.status).sort()).toEqual([200, 400]);
    let stored = database
      .prepare(
        `SELECT t.recur_every_days AS recurrence,
                EXISTS(SELECT 1 FROM task_fixed_slots s WHERE s.task_id=t.id) AS hasSlot
         FROM tasks t WHERE t.id=?`,
      )
      .get(task.id) as { recurrence: number | null; hasSlot: number };
    expect(Boolean(stored.recurrence) !== Boolean(stored.hasSlot)).toBe(true);

    if (!stored.hasSlot) {
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ recurEveryDays: null, fixedSlot: utcSlot })
        .expect(200);
    } else {
      await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: null }).expect(200);
    }
    // Make the task drawable, deal it, then race restore/candidate reads with
    // a slot set. Reads may linearize first, but the committed final state is
    // never persisted/restored/candidate-visible.
    await request(app).patch(`/api/tasks/${task.id}`).send({ recurEveryDays: null, fixedSlot: null }).expect(200);
    expect((await request(app).post("/api/draw").send({}).expect(200)).body.task.id).toBe(task.id);
    await Promise.all([
      request(app).get("/api/draw/current").expect(200),
      request(app).get("/api/draw/pool").expect(200),
      request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: utcSlot }).expect(200),
    ]);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([]);
    stored = database
      .prepare(
        `SELECT t.recur_every_days AS recurrence,
                EXISTS(SELECT 1 FROM task_fixed_slots s WHERE s.task_id=t.id) AS hasSlot
         FROM tasks t WHERE t.id=?`,
      )
      .get(task.id) as { recurrence: number | null; hasSlot: number };
    expect(stored).toEqual({ recurrence: null, hasSlot: 1 });
  });

  it("keeps due-only backlog and recurring laundry behavior independent from slots", async () => {
    const database = await testDb();
    database.prepare("UPDATE tasks SET status='archived' WHERE status='open'").run();
    const day = (offset: number) => {
      const value = new Date();
      value.setHours(12, 0, 0, 0);
      value.setDate(value.getDate() + offset);
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    };
    const deadline = await create("Due-only backlog", { dueDate: day(7) });
    const laundry = await create("Due-only recurring laundry", {
      dueDate: day(1),
      recurEveryDays: 3,
    });
    let pool = (await request(app).get("/api/draw/pool").expect(200)).body.candidates;
    expect(pool.map((task: { id: number }) => task.id)).toContain(deadline.id);
    expect(pool.map((task: { id: number }) => task.id)).not.toContain(laundry.id);

    await request(app).patch(`/api/tasks/${laundry.id}`).send({ dueDate: day(0) }).expect(200);
    pool = (await request(app).get("/api/draw/pool").expect(200)).body.candidates;
    expect(pool.map((task: { id: number }) => task.id)).toContain(laundry.id);
    const completed = await request(app)
      .patch(`/api/tasks/${laundry.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(completed.body.task).toMatchObject({
      status: "open",
      dueDate: day(3),
      recurEveryDays: 3,
      hasFixedSlot: false,
      fixedSlot: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots WHERE task_id=?").get(laundry.id)).toEqual({ n: 0 });
  });

  it("allows fixed overlap and explicit timer work without automatic timer writes", async () => {
    const first = await create("First overlap", { fixedSlot: utcSlot });
    const second = await create("Second overlap", {
      fixedSlot: { ...utcSlot, startLocal: "2026-10-20T10:30", endLocal: "2026-10-20T11:30" },
    });
    await request(app).post(`/api/tasks/${first.id}/timer/start`).expect(200);
    await request(app)
      .patch(`/api/tasks/${second.id}`)
      .send({ fixedSlot: { ...utcSlot, startLocal: "2026-10-20T09:30", endLocal: "2026-10-20T12:00" } })
      .expect(200);
    const database = await testDb();
    expect(database.prepare("SELECT task_id AS taskId, ended_at AS endedAt FROM time_entries").all()).toEqual([
      { taskId: first.id, endedAt: null },
    ]);
  });

  it("retains slots through completion, reopen, archive, unarchive, reparent and breakdown; delete cascades", async () => {
    const fixed = await create("Retained appointment", { fixedSlot: utcSlot });
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ status: "done" }).expect(200);
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ status: "open" }).expect(200);
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ status: "archived" }).expect(200);
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ status: "open" }).expect(200);

    const parent = await create("Adoptive parent");
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ parentId: parent.id }).expect(200);
    await request(app).patch(`/api/tasks/${fixed.id}`).send({ parentId: null }).expect(200);
    await request(app)
      .post(`/api/tasks/${fixed.id}/subtasks`)
      .send({ subtasks: [{ title: "Ordinary child", effortMinutes: 5 }] })
      .expect(201);

    const database = await testDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots WHERE task_id=?").get(fixed.id)).toEqual({ n: 1 });

    const autoParent = await create("Fixed auto-completing parent", { fixedSlot: utcSlot });
    const autoChild = await create("Last child", { parentId: autoParent.id });
    await request(app).patch(`/api/tasks/${autoChild.id}`).send({ status: "done" }).expect(200);
    expect(database.prepare("SELECT status FROM tasks WHERE id=?").get(autoParent.id)).toEqual({ status: "done" });
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots WHERE task_id=?").get(autoParent.id)).toEqual({ n: 1 });

    const cascadeParent = await create("Cascade parent");
    const cascadeChild = await create("Cascade fixed child", {
      parentId: cascadeParent.id,
      fixedSlot: utcSlot,
    });
    await request(app).delete(`/api/tasks/${cascadeParent.id}`).expect(200);
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots WHERE task_id=?").get(cascadeChild.id)).toEqual({ n: 0 });

    await request(app).delete(`/api/tasks/${fixed.id}`).expect(200);
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots WHERE task_id=?").get(fixed.id)).toEqual({ n: 0 });
  });

  it("round-trips fixed slots through manual/scheduled archives, restore, and app.db.bak", async () => {
    const portable = await create("Portable appointment", {
      dueDate: "2026-12-24",
      fixedSlot: utcSlot,
    });
    const manualPath = createBackupArchive();
    const manualBytes = fs.readFileSync(manualPath);
    fs.rmSync(manualPath, { force: true });
    const scheduled = runScheduledBackup(3, new Date("2026-10-01T12:00:00.000Z"));

    const inspectArchive = (bytes: Buffer, name: string) => {
      const dbPath = path.join(process.env.DATA_DIR!, name);
      fs.writeFileSync(dbPath, new AdmZip(bytes).getEntry("app.db")!.getData());
      const handle = new Database(dbPath, { readonly: true });
      try {
        expect(() => validateV22Contract(handle)).not.toThrow();
        expect(
          handle.prepare("SELECT starts_at AS startsAt,entry_timezone AS zone FROM task_fixed_slots WHERE task_id=?").get(portable.id),
        ).toEqual({ startsAt: "2026-10-20T10:00:00.000Z", zone: "UTC" });
      } finally {
        handle.close();
        fs.rmSync(dbPath, { force: true });
      }
    };
    inspectArchive(manualBytes, "inspect-manual.db");
    inspectArchive(fs.readFileSync(scheduled.path), "inspect-scheduled.db");

    // Restore validates the stamped v22 rows with the frozen registry before
    // swap; a host-recognized backward alias is still rejected.
    const badZip = new AdmZip(manualBytes);
    const badDbPath = path.join(process.env.DATA_DIR!, "tampered-v22-slot.db");
    fs.writeFileSync(badDbPath, badZip.getEntry("app.db")!.getData());
    const badDb = new Database(badDbPath);
    try {
      badDb.prepare("UPDATE task_fixed_slots SET entry_timezone='US/Eastern' WHERE task_id=?").run(portable.id);
    } finally {
      badDb.close();
    }
    badZip.deleteFile("app.db");
    badZip.addFile("app.db", fs.readFileSync(badDbPath));
    fs.rmSync(badDbPath, { force: true });
    await request(app)
      .post("/api/backup/import")
      .attach("file", badZip.toBuffer(), "tampered-v22-slot.zip")
      .expect(400);
    expect(
      (await request(app).get("/api/tasks?status=all").expect(200)).body.find(
        (task: { id: number }) => task.id === portable.id,
      ),
    ).toMatchObject({ dueDate: "2026-12-24", fixedSlot: { entryTimezone: "UTC" } });

    await request(app)
      .patch(`/api/tasks/${portable.id}`)
      .send({ dueDate: "2030-01-01", fixedSlot: null })
      .expect(200);
    const safety = await create("Safety-copy appointment", { fixedSlot: utcSlot });
    await request(app)
      .post("/api/backup/import")
      .attach("file", manualBytes, "fixed-slot-backup.zip")
      .expect(200);

    const restored = (await request(app).get("/api/tasks?status=all").expect(200)).body.find(
      (task: { id: number }) => task.id === portable.id,
    );
    expect(restored).toMatchObject({
      dueDate: "2026-12-24",
      fixedSlot: { ...utcSlot, startsAt: "2026-10-20T10:00:00.000Z" },
    });
    const bak = new Database(path.join(process.env.DATA_DIR!, "app.db.bak"), { readonly: true });
    try {
      expect(() => validateV22Contract(bak)).not.toThrow();
      expect(bak.prepare("SELECT entry_timezone AS zone FROM task_fixed_slots WHERE task_id=?").get(safety.id)).toEqual({ zone: "UTC" });
    } finally {
      bak.close();
    }
  });

  it("does not project fixed-only data into today's due-date surface", async () => {
    const fixed = await create("Fixed only must stay out of today", { fixedSlot: utcSlot });
    const today = await request(app).get("/api/daily-overview?timezone=UTC").expect(200);
    expect(JSON.stringify(today.body)).not.toContain("Fixed only must stay out of today");
    // The task itself still exposes the fact for task UI/REST callers.
    const listed = (await request(app).get("/api/tasks").expect(200)).body.find(
      (task: { id: number }) => task.id === fixed.id,
    );
    expect(listed.hasFixedSlot).toBe(true);
  });
});
