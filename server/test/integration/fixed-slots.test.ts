import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { freshApp, testDb } from "../helpers.js";
import { executeTool, type ApiClient } from "../../src/tools/catalog.js";
import { createBackupArchive, runScheduledBackup } from "../../src/services/backupService.js";
import { validateV22Contract } from "../../src/schemaV22.js";
import { stagedTaskInputSchema } from "../../src/services/agentStaging.js";
import {
  forbiddenFixedSlotInput,
  namedZoneBoundaryFailures,
  rejectedScheduleZones,
  supportedAutomationSlotVectors,
  validUtcBoundarySlots,
} from "../fixedSlotVectors.js";

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

type CoordinatedRequest = {
  method: "get" | "post" | "patch";
  url: string;
  body?: unknown;
};
type WorkerMessage = {
  type: "ready" | "attempting" | "result" | "failure";
  status?: number;
  body?: unknown;
  error?: string;
};

function waitForMessage(worker: Worker, type: WorkerMessage["type"]): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number) => reject(new Error(`coordinated request worker exited ${code}`));
    const onMessage = (message: WorkerMessage) => {
      if (message.type === "failure") {
        cleanup();
        reject(new Error(message.error));
      } else if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const cleanup = () => {
      worker.off("exit", onExit);
      worker.off("message", onMessage);
    };
    worker.on("exit", onExit);
    worker.on("message", onMessage);
  });
}

/**
 * Start independent real Express/SQLite worker connections, hold them behind
 * one external IMMEDIATE lock, then release only after every request has crossed
 * the explicit start barrier. This forces genuine connection contention and
 * cannot collapse into Promise.all over synchronous in-process handlers.
 */
async function coordinatedRequests(commands: CoordinatedRequest[]) {
  const worker = fileURLToPath(new URL("../helpers/concurrentRequestWorker.ts", import.meta.url));
  const children = commands.map(() =>
    new Worker(worker, {
      env: { ...process.env },
      execArgv: ["--import", "tsx"],
      stdout: true,
      stderr: true,
    }),
  );
  const diagnostics = new Map<Worker, string>();
  for (const child of children) {
    diagnostics.set(child, "");
    child.stderr.on("data", (chunk) => diagnostics.set(child, diagnostics.get(child)! + chunk));
  }
  let blocker: Database.Database | undefined;
  try {
    await Promise.all(children.map((child) => waitForMessage(child, "ready")));
    blocker = new Database(path.join(process.env.DATA_DIR!, "app.db"));
    blocker.pragma("busy_timeout=5000");
    blocker.exec("BEGIN IMMEDIATE");

    const attempts = children.map((child) => waitForMessage(child, "attempting"));
    const results = children.map((child) => waitForMessage(child, "result"));
    children.forEach((child, index) => child.postMessage({ type: "request", ...commands[index] }));
    await Promise.all(attempts);
    // Both independent handlers have left the barrier and are now queued at
    // their real SQLite transaction boundaries behind this lock.
    await delay(75);
    blocker.exec("COMMIT");
    blocker.close();
    blocker = undefined;
    return await Promise.all(results);
  } catch (error) {
    const stderr = children.map((child) => diagnostics.get(child)).filter(Boolean).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
  } finally {
    if (blocker) {
      if (blocker.inTransaction) blocker.exec("ROLLBACK");
      blocker.close();
    }
    await Promise.all(children.map((child) => child.terminate()));
  }
}

describe("fixed-slot REST contract", () => {
  it("sets, moves, changes zone, replaces and clears without changing deadline, availability or work bytes", async () => {
    const task = await create("Anchored appointment", {
      dueDate: "2026-11-30",
      windowDays: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    const database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
    ).run(task.id, "2026-10-19T08:00:00.123Z", "2026-10-19T08:45:59.987Z");
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,NULL)",
    ).run(task.id, "2026-09-20T09:01:02.003Z");
    const workBytes = () => database
      .prepare("SELECT id,task_id,started_at,ended_at FROM time_entries WHERE task_id=? ORDER BY id")
      .all(task.id);
    const before = workBytes();

    const assertIndependentFacts = (body: { task: Record<string, unknown> }) => {
      expect(body.task).toMatchObject({
        dueDate: "2026-11-30",
        windowDays: [1, 2, 3, 4, 5],
      });
      expect(workBytes()).toEqual(before);
    };

    const set = await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: utcSlot }).expect(200);
    assertIndependentFacts(set.body);
    expect(set.body.task).toMatchObject({
      hasFixedSlot: true,
      fixedSlot: {
        ...utcSlot,
        startsAt: "2026-10-20T10:00:00.000Z",
        endsAt: "2026-10-20T11:00:00.000Z",
        startOffsetSeconds: 0,
        endOffsetSeconds: 0,
      },
    });

    const moved = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ fixedSlot: { ...utcSlot, startLocal: "2026-10-21T10:00", endLocal: "2026-10-21T11:00" } })
      .expect(200);
    assertIndependentFacts(moved.body);

    const zoneChanged = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        fixedSlot: {
          startLocal: "2026-10-21T10:00",
          endLocal: "2026-10-21T11:00",
          entryTimezone: "America/New_York",
        },
      })
      .expect(200);
    assertIndependentFacts(zoneChanged.body);

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
    assertIndependentFacts(replaced.body);
    expect(replaced.body.task).toMatchObject({
      title: "Anchored appointment moved",
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

    const cleared = await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: null }).expect(200);
    assertIndependentFacts(cleared.body);
    expect(cleared.body.task).toMatchObject({ hasFixedSlot: false, fixedSlot: null });
    await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: null }).expect(200);
    expect(workBytes()).toEqual(before);
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
      ...rejectedScheduleZones.map((entryTimezone) => ({ ...utcSlot, entryTimezone })),
      { ...utcSlot, startLocal: "2026-10-20T12:00" },
    ];
    for (const fixedSlot of badInputs) {
      await request(app)
        .post("/api/tasks")
        .send({ title: "Must not exist", categoryId: 1, dueDate: "2026-12-01", fixedSlot })
        .expect(400);
    }
    for (const [key, value] of Object.entries(forbiddenFixedSlotInput).filter(([key]) => key !== "fixedSlot")) {
      await request(app)
        .post("/api/tasks")
        .send({ title: `No forged ${key}`, categoryId: 1, [key]: value })
        .expect(400);
    }
    await request(app).patch("/api/tasks/999999").send({ fixedSlot: utcSlot }).expect(404);
    const database = await testDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='Must not exist'").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM task_fixed_slots").get()).toMatchObject({ n: expect.any(Number) });
  });

  it("carries shared UTC controls and named-zone underflow/overflow through REST writes", async () => {
    const lower = await create("REST lower UTC control", { fixedSlot: validUtcBoundarySlots[0].slot });
    expect(lower.fixedSlot).toMatchObject({
      startsAt: validUtcBoundarySlots[0].startsAt,
      endsAt: validUtcBoundarySlots[0].endsAt,
    });
    const upper = await request(app)
      .patch(`/api/tasks/${lower.id}`)
      .send({ fixedSlot: validUtcBoundarySlots[1].slot })
      .expect(200);
    expect(upper.body.task.fixedSlot).toMatchObject({
      startsAt: validUtcBoundarySlots[1].startsAt,
      endsAt: validUtcBoundarySlots[1].endsAt,
    });

    for (const vector of namedZoneBoundaryFailures) {
      const title = `REST rejects ${vector.name}`;
      const createResponse = await request(app)
        .post("/api/tasks")
        .send({ title, categoryId: 1, fixedSlot: vector.slot })
        .expect(400);
      expect(createResponse.body.error).toContain("outside supported UTC years");
      const updateResponse = await request(app)
        .patch(`/api/tasks/${lower.id}`)
        .send({ title: "must roll back", fixedSlot: vector.slot })
        .expect(400);
      expect(updateResponse.body.error).toContain("outside supported UTC years");
    }
    const listed = (await request(app).get("/api/tasks?status=all").expect(200)).body;
    expect(listed.some((task: { title: string }) => task.title.startsWith("REST rejects"))).toBe(false);
    expect(listed.find((task: { id: number }) => task.id === lower.id)).toMatchObject({
      title: "REST lower UTC control",
      fixedSlot: { startsAt: validUtcBoundarySlots[1].startsAt },
    });
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

describe("phase-1B automation boundaries", () => {
  const api: ApiClient = {
    async request(method, url, body) {
      const call = request(app)[method.toLowerCase() as "get" | "post" | "patch"](url);
      const response = body === undefined ? await call : await call.send(body as string | object);
      return { status: response.status, body: response.body };
    },
  };

  it("uses the same MCP shape, resolver, fold and UTC-boundary vectors as REST", async () => {
    const updateTarget = await create("MCP shared-vector update target");
    for (const vector of [...supportedAutomationSlotVectors, ...validUtcBoundarySlots]) {
      const outcome = await executeTool("create_task", api, {
        title: `MCP ${vector.name}`,
        categoryId: 1,
        fixedSlot: vector.slot,
      });
      expect(outcome.isError, vector.name).toBeUndefined();
      expect(JSON.parse(outcome.text)).toMatchObject({
        fixedSlot: {
          ...vector.slot,
          startsAt: vector.startsAt,
          endsAt: vector.endsAt,
        },
      });
      const updated = await executeTool("update_task", api, {
        id: updateTarget.id,
        fixedSlot: vector.slot,
      });
      expect(updated.isError, `${vector.name} update`).toBeUndefined();
      expect(JSON.parse(updated.text).task.fixedSlot).toMatchObject({
        ...vector.slot,
        startsAt: vector.startsAt,
        endsAt: vector.endsAt,
      });
    }

    for (const [index, zone] of rejectedScheduleZones.entries()) {
      const rejected = await executeTool("create_task", api, {
        title: `MCP rejected zone ${index}`,
        categoryId: 1,
        fixedSlot: { ...utcSlot, entryTimezone: zone },
      });
      expect(rejected.isError, zone).toBe(true);
      expect(rejected.text).toContain("supported canonical schedule timezone");
      const rejectedUpdate = await executeTool("update_task", api, {
        id: updateTarget.id,
        fixedSlot: { ...utcSlot, entryTimezone: zone },
      });
      expect(rejectedUpdate.isError, `${zone} update`).toBe(true);
      expect(rejectedUpdate.text).toContain("supported canonical schedule timezone");
    }

    const stable = await create("MCP boundary rollback", { fixedSlot: utcSlot });
    for (const vector of namedZoneBoundaryFailures) {
      const rejectedCreate = await executeTool("create_task", api, {
        title: `MCP rejected ${vector.name}`,
        categoryId: 1,
        fixedSlot: vector.slot,
      });
      expect(rejectedCreate.isError).toBe(true);
      expect(rejectedCreate.text).toContain("outside supported UTC years");

      const rejectedUpdate = await executeTool("update_task", api, {
        id: stable.id,
        title: "must roll back",
        fixedSlot: vector.slot,
      });
      expect(rejectedUpdate.isError).toBe(true);
      expect(rejectedUpdate.text).toContain("outside supported UTC years");
    }
    const unchanged = (await request(app).get("/api/tasks").expect(200)).body.find(
      (candidate: { id: number }) => candidate.id === stable.id,
    );
    expect(unchanged).toMatchObject({ title: "MCP boundary rollback", fixedSlot: utcSlot });
  });

  it("sets, replaces and clears atomically while preserving independent facts", async () => {
    const task = await create("MCP independent facts", {
      dueDate: "2026-12-24",
      windowDays: [1, 3],
      windowStart: "09:00",
      windowEnd: "12:00",
    });
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);

    const set = await executeTool("update_task", api, {
      id: task.id,
      fixedSlot: supportedAutomationSlotVectors[1].slot,
    });
    expect(set.isError).toBeUndefined();
    expect(JSON.parse(set.text).task.fixedSlot).toMatchObject({
      ...supportedAutomationSlotVectors[1].slot,
      startsAt: supportedAutomationSlotVectors[1].startsAt,
    });

    const replace = await executeTool("update_task", api, {
      id: task.id,
      fixedSlot: supportedAutomationSlotVectors[2].slot,
    });
    expect(replace.isError).toBeUndefined();
    const database = await testDb();
    expect(database.prepare("SELECT due_date AS dueDate,window_days AS windowDays,window_start AS windowStart,window_end AS windowEnd FROM tasks WHERE id=?").get(task.id)).toEqual({
      dueDate: "2026-12-24",
      windowDays: "[1,3]",
      windowStart: "09:00",
      windowEnd: "12:00",
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE task_id=?").get(task.id)).toEqual({ n: 1 });

    const clear = await executeTool("update_task", api, { id: task.id, fixedSlot: null });
    expect(clear.isError).toBeUndefined();
    expect(JSON.parse(clear.text).task).toMatchObject({ fixedSlot: null, hasFixedSlot: false });
    expect((await executeTool("update_task", api, { id: task.id, fixedSlot: null })).isError).toBeUndefined();
  });

  it("supports atomic recurrence transitions, rollback, current-card invalidation and omission", async () => {
    const recurring = await create("MCP transition from recurrence", { recurEveryDays: 3 });
    const set = await executeTool("update_task", api, {
      id: recurring.id,
      recurEveryDays: null,
      fixedSlot: utcSlot,
    });
    expect(set.isError).toBeUndefined();
    expect(JSON.parse(set.text).task).toMatchObject({ recurEveryDays: null, fixedSlot: utcSlot });

    const reverse = await executeTool("update_task", api, {
      id: recurring.id,
      fixedSlot: null,
      recurEveryDays: 5,
    });
    expect(reverse.isError).toBeUndefined();
    expect(JSON.parse(reverse.text).task).toMatchObject({ fixedSlot: null, recurEveryDays: 5 });

    const before = (await testDb()).prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    const conflict = await executeTool("create_task", api, {
      title: "MCP conflict must roll back",
      categoryId: 1,
      recurEveryDays: 2,
      fixedSlot: utcSlot,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("cannot have both");
    expect((await testDb()).prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual(before);
    expect((await executeTool("update_task", api, { id: 999999, fixedSlot: utcSlot })).text).toContain("404");

    const database = await testDb();
    database.prepare("UPDATE tasks SET status='archived' WHERE status='open'").run();
    database.prepare("DELETE FROM settings WHERE key IN ('current_draw_task_id','warmup_current_draw')").run();
    const current = await create("MCP current-card invalidation");
    expect((await request(app).post("/api/draw").send({}).expect(200)).body.task.id).toBe(current.id);
    expect((await executeTool("update_task", api, { id: current.id, fixedSlot: utcSlot })).isError).toBeUndefined();
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();

    const ordinary = await executeTool("update_task", api, { id: current.id, title: "MCP omitted slot" });
    expect(ordinary.isError).toBeUndefined();
    expect(JSON.parse(ordinary.text).task).toMatchObject({ title: "MCP omitted slot", fixedSlot: utcSlot });
  });

  it("keeps both automation schemas closed around the approved intersection", () => {
    expect(stagedTaskInputSchema.safeParse({ title: "slot", categoryId: 1, fixedSlot: utcSlot }).success).toBe(true);
    expect(stagedTaskInputSchema.safeParse({ title: "clear", categoryId: 1, fixedSlot: null }).success).toBe(false);
    for (const [key, value] of Object.entries(forbiddenFixedSlotInput).filter(([key]) => key !== "fixedSlot")) {
      expect(stagedTaskInputSchema.safeParse({ title: key, categoryId: 1, [key]: value }).success).toBe(false);
    }
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

  it("coordinates independent transaction contenders for recurrence, Draw selection, set and replace", async () => {
    const database = await testDb();
    database.prepare("UPDATE tasks SET status='archived' WHERE status='open'").run();
    database.prepare("DELETE FROM settings WHERE key IN ('current_draw_task_id','warmup_current_draw')").run();

    const invariantTask = await create("Coordinated recurrence contender");
    const recurrenceRace = await coordinatedRequests([
      { method: "patch", url: `/api/tasks/${invariantTask.id}`, body: { fixedSlot: utcSlot } },
      { method: "patch", url: `/api/tasks/${invariantTask.id}`, body: { recurEveryDays: 2 } },
    ]);
    expect(recurrenceRace.map((response) => response.status).sort()).toEqual([200, 400]);
    const invariantState = database
      .prepare(
        `SELECT t.recur_every_days AS recurrence,
                EXISTS(SELECT 1 FROM task_fixed_slots s WHERE s.task_id=t.id) AS hasSlot
         FROM tasks t WHERE t.id=?`,
      )
      .get(invariantTask.id) as { recurrence: number | null; hasSlot: number };
    expect(!((invariantState.recurrence != null) && Boolean(invariantState.hasSlot))).toBe(true);
    database.prepare("UPDATE tasks SET status='archived' WHERE id=?").run(invariantTask.id);

    const drawTask = await create("Coordinated Draw contender");
    const setRace = await coordinatedRequests([
      { method: "post", url: "/api/draw", body: {} },
      { method: "patch", url: `/api/tasks/${drawTask.id}`, body: { fixedSlot: utcSlot } },
    ]);
    expect(setRace.map((response) => response.status)).toEqual([200, 200]);
    const drawOutcome = setRace[0].body as { task: { id: number } | null };
    expect(drawOutcome.task === null || drawOutcome.task.id === drawTask.id).toBe(true);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([]);

    // A deliberately stale pointer makes current-card restoration contend
    // with a real slot replacement. Both linearizations are valid, but no
    // committed result may restore/persist the slotted card.
    database.prepare(
      "INSERT OR REPLACE INTO settings(key,value) VALUES ('current_draw_task_id',?)",
    ).run(String(drawTask.id));
    const replacement = {
      startLocal: "2026-10-21T10:00",
      endLocal: "2026-10-21T11:00",
      entryTimezone: "UTC",
    };
    const replaceRace = await coordinatedRequests([
      { method: "get", url: "/api/draw/current" },
      { method: "get", url: "/api/draw/pool" },
      { method: "patch", url: `/api/tasks/${drawTask.id}`, body: { fixedSlot: replacement } },
    ]);
    expect(replaceRace.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(replaceRace[0].body).toBeNull();
    expect((replaceRace[1].body as { candidates: unknown[] }).candidates).toEqual([]);
    expect((replaceRace[2].body as { task: { fixedSlot: unknown } }).task.fixedSlot).toMatchObject(replacement);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    expect(database.prepare("SELECT value FROM settings WHERE key='current_draw_task_id'").get()).toBeUndefined();
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
    expect(
      database.prepare(
        "SELECT task_id AS taskId,ended_at AS endedAt FROM time_entries WHERE task_id IN (?,?) ORDER BY id",
      ).all(first.id, second.id),
    ).toEqual([{ taskId: first.id, endedAt: null }]);
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
    const boundaryTasks: Array<{ id: number }> = [];
    for (const [index, vector] of validUtcBoundarySlots.entries()) {
      boundaryTasks.push(await create(`Portable ${vector.name}`, {
        dueDate: `2026-12-2${index}`,
        fixedSlot: vector.slot,
      }));
    }
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
        for (const [index, vector] of validUtcBoundarySlots.entries()) {
          expect(
            handle.prepare("SELECT starts_at AS startsAt,ends_at AS endsAt,entry_timezone AS zone FROM task_fixed_slots WHERE task_id=?")
              .get(boundaryTasks[index].id),
          ).toEqual({ startsAt: vector.startsAt, endsAt: vector.endsAt, zone: "UTC" });
        }
      } finally {
        handle.close();
        fs.rmSync(dbPath, { force: true });
      }
    };
    inspectArchive(manualBytes, "inspect-manual.db");
    inspectArchive(fs.readFileSync(scheduled.path), "inspect-scheduled.db");

    // Restore validates stamped v22 rows with the frozen registry before
    // swap. Exercise an alias and both named-zone year-edge projections, not
    // merely direct validator calls.
    const restoreTamper = async (
      name: string,
      startsAt: string,
      endsAt: string,
      zone: string,
    ) => {
      const badZip = new AdmZip(manualBytes);
      const badDbPath = path.join(process.env.DATA_DIR!, `tampered-v22-${name}.db`);
      fs.writeFileSync(badDbPath, badZip.getEntry("app.db")!.getData());
      const badDb = new Database(badDbPath);
      try {
        badDb.prepare(
          "UPDATE task_fixed_slots SET starts_at=?,ends_at=?,entry_timezone=? WHERE task_id=?",
        ).run(startsAt, endsAt, zone, portable.id);
      } finally {
        badDb.close();
      }
      badZip.deleteFile("app.db");
      badZip.addFile("app.db", fs.readFileSync(badDbPath));
      fs.rmSync(badDbPath, { force: true });
      await request(app)
        .post("/api/backup/import")
        .attach("file", badZip.toBuffer(), `tampered-v22-${name}.zip`)
        .expect(400);
    };
    await restoreTamper(
      "alias",
      "2026-10-20T10:00:00.000Z",
      "2026-10-20T11:00:00.000Z",
      "US/Eastern",
    );
    await restoreTamper(
      "named-underflow",
      validUtcBoundarySlots[0].startsAt,
      validUtcBoundarySlots[0].endsAt,
      "America/New_York",
    );
    await restoreTamper(
      "named-overflow",
      validUtcBoundarySlots[1].startsAt,
      validUtcBoundarySlots[1].endsAt,
      "Europe/Berlin",
    );
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
    const restoredTasks = (await request(app).get("/api/tasks?status=all").expect(200)).body;
    for (const [index, vector] of validUtcBoundarySlots.entries()) {
      expect(restoredTasks.find((task: { id: number }) => task.id === boundaryTasks[index].id)).toMatchObject({
        dueDate: `2026-12-2${index}`,
        fixedSlot: { startsAt: vector.startsAt, endsAt: vector.endsAt, entryTimezone: "UTC" },
      });
    }
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
