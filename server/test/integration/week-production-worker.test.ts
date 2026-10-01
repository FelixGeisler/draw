import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";

interface InstrumentEvent {
  type: string;
  threadId: number;
  messageType?: string;
  code?: string | number;
  options?: { readonly?: boolean; fileMustExist?: boolean };
  source?: string;
  blocked?: boolean;
  identity?: boolean;
  sqlContainsTitle?: boolean;
  prefixLimit?: number;
  active?: number;
  maxActive?: number;
  records?: number;
  containsForbiddenSuffix?: boolean;
}

const eventFile = path.join(process.env.DATA_DIR!, "week-worker-events.jsonl");
const releaseFile = path.join(process.env.DATA_DIR!, "week-worker-release");
const preload = path.join(process.cwd(), "test", "instrumentation", "weekWorkerPreload.cjs");
const originalNodeOptions = process.env.NODE_OPTIONS;
let app: Express;
let shutdownWeekProjection: typeof import("../../src/db.js")["shutdownWeekProjection"];
let testDb: typeof import("../helpers.js")["testDb"];

function events(): InstrumentEvent[] {
  if (!fs.existsSync(eventFile)) return [];
  return fs.readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as InstrumentEvent);
}

async function waitFor(predicate: (rows: InstrumentEvent[]) => boolean): Promise<InstrumentEvent[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = events();
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for production worker instrumentation");
}

function setMode(mode: string): void {
  process.env.DRAW_WEEK_TEST_MODE = mode;
}

async function seed(): Promise<void> {
  const database = await testDb();
  const task = database.prepare(
    "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,'open','2026-01-01T00:00:00.000Z')",
  );
  database.transaction(() => {
    for (let index = 0; index < 101; index += 1) {
      task.run(70_000 + index, `instrumented-title-${index}`, "2033-12-28");
    }
    task.run(71_000, `${"😀".repeat(40_000)}NEVER-IN-WORKER-IPC`, "2034-01-11");
  })();
  database.close();
}

beforeAll(async () => {
  fs.writeFileSync(eventFile, "");
  fs.rmSync(releaseFile, { force: true });
  process.env.NODE_OPTIONS = `${originalNodeOptions ? `${originalNodeOptions} ` : ""}--require=${preload}`;
  process.env.DRAW_WEEK_TEST_EVENT_FILE = eventFile;
  process.env.DRAW_WEEK_FORBIDDEN_SUFFIX = "NEVER-IN-WORKER-IPC";
  setMode("observe");
  app = (await import("../../src/app.js")).createApp();
  ({ shutdownWeekProjection } = await import("../../src/db.js"));
  ({ testDb } = await import("../helpers.js"));
  await seed();
});

afterAll(async () => {
  await shutdownWeekProjection();
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  delete process.env.DRAW_WEEK_TEST_EVENT_FILE;
  delete process.env.DRAW_WEEK_TEST_MODE;
  delete process.env.DRAW_WEEK_TEST_RELEASE_FILE;
  delete process.env.DRAW_WEEK_FORBIDDEN_SUFFIX;
  fs.rmSync(releaseFile, { force: true });
});

describe.sequential("production Week worker instrumentation", () => {
  it("proves the sole lazy configured connection, reuse, title ordering/count/bounds, and result-only IPC", async () => {
    expect(events()).toEqual([]);
    const first = await import("supertest").then(({ default: request }) => request(app)
      .get("/api/calendar/week?weekStart=2033-12-26&timezone=UTC").expect(200));
    expect(first.body.records).toHaveLength(100);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await import("supertest").then(({ default: request }) => request(app)
      .get(`/api/calendar/week?weekStart=2033-12-26&timezone=UTC&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200));
    expect(second.body.records).toHaveLength(1);
    const bounded = await import("supertest").then(({ default: request }) => request(app)
      .get("/api/calendar/week?weekStart=2034-01-09&timezone=UTC").expect(200));
    expect(bounded.body.records).toHaveLength(1);
    expect(bounded.body.records[0].titleTruncated).toBe(true);
    expect(bounded.text).not.toContain("NEVER-IN-WORKER-IPC");

    const rows = events();
    const opens = rows.filter((row) => row.type === "connection-open");
    expect(opens).toHaveLength(1);
    expect(opens[0].options).toEqual({ readonly: true, fileMustExist: true });
    expect(rows.filter((row) => row.type === "udf-registration")).toHaveLength(0);
    expect(rows.find((row) => row.type === "query-only-write-attempt")).toMatchObject({ blocked: true });
    for (const pragma of [
      "trusted_schema = OFF", "query_only = ON", "cache_size = -2048", "temp_store = FILE",
    ]) expect(rows.some((row) => row.type === "pragma" && row.source === pragma)).toBe(true);

    const identityIndexes = rows.map((row, index) => row.type === "identity-all" ? index : -1).filter((index) => index >= 0);
    const titleIndexes = rows.map((row, index) => row.type === "title-get-start" ? index : -1).filter((index) => index >= 0);
    expect(identityIndexes).toHaveLength(3);
    expect(titleIndexes[0]).toBeGreaterThan(identityIndexes[0]);
    const firstResultIndex = rows.findIndex((row) => row.type === "result-ipc");
    expect(rows.slice(identityIndexes[0], firstResultIndex).filter((row) => row.type === "title-get-start")).toHaveLength(100);
    expect(rows.filter((row) => row.type === "title-get-start").every((row) =>
      Number.isInteger(row.prefixLimit) && row.prefixLimit! <= 131_076)).toBe(true);
    expect(Math.max(...rows.filter((row) => row.type === "title-get-end").map((row) => row.maxActive ?? 0))).toBe(1);
    expect(rows.filter((row) => row.type === "prepare" && row.identity)
      .every((row) => row.sqlContainsTitle === false)).toBe(true);
    expect(rows.filter((row) => row.type === "result-ipc")
      .every((row) => row.containsForbiddenSuffix === false)).toBe(true);
  });

  it("keeps a real disconnected HTTP computation busy while main-thread health remains responsive", async () => {
    await shutdownWeekProjection();
    setMode("block");
    process.env.DRAW_WEEK_TEST_RELEASE_FILE = releaseFile;
    fs.rmSync(releaseFile, { force: true });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const target = `${origin}/api/calendar/week?weekStart=2033-12-26&timezone=UTC`;
    const abort = new AbortController();
    const blockStart = events().length;
    const abandoned = fetch(target, { signal: abort.signal });
    try {
      await waitFor((rows) => rows.slice(blockStart).some((row) => row.type === "identity-blocked"));
      abort.abort();
      await expect(abandoned).rejects.toThrow();
      const [busy, health] = await Promise.all([fetch(target), fetch(`${origin}/api/health`)]);
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ error: "week-projection-busy" });
      expect(health.status).toBe(200);
      fs.writeFileSync(releaseFile, "release");
      await waitFor((rows) => rows.slice(blockStart).some((row) => row.type === "identity-released") &&
        rows.slice(blockStart).some((row) => row.type === "result-ipc"));
      let recovered = await fetch(target);
      for (let attempt = 0; recovered.status === 503 && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        recovered = await fetch(target);
      }
      expect(recovered.status).toBe(200);
    } finally {
      fs.writeFileSync(releaseFile, "release");
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      delete process.env.DRAW_WEEK_TEST_RELEASE_FILE;
      fs.rmSync(releaseFile, { force: true });
    }
  });

  it("maps every recoverable production-path fault to one generic 500 without retry or partial output", async () => {
    const request = (await import("supertest")).default;
    for (const mode of ["query", "allocation", "worker-failure", "protocol", "structural", "title-metadata"]) {
      await shutdownWeekProjection();
      const start = events().length;
      setMode(mode);
      const response = await request(app)
        .get("/api/calendar/week?weekStart=2033-12-26&timezone=UTC")
        .expect(500)
        .expect("Cache-Control", "no-store")
        .expect("Content-Type", /json/);
      expect(response.body).toEqual({ error: "week-projection-failed" });
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(response.text).not.toContain("records");
      const attempt = events().slice(start);
      expect(attempt.filter((row) => row.type === "connection-open")).toHaveLength(1);
      expect(attempt.filter((row) => row.type === "identity-all").length).toBeLessThanOrEqual(1);
      expect(attempt.filter((row) => row.type === "title-get-start").length).toBeLessThanOrEqual(100);

      if (mode === "protocol" || mode === "structural") {
        const failedThread = attempt.find((row) => row.type === "connection-open")!.threadId;
        const recoveryStart = events().length;
        setMode("observe");
        await request(app)
          .get("/api/calendar/week?weekStart=2033-12-26&timezone=UTC")
          .expect(200);
        const recovery = events().slice(recoveryStart);
        const recoveredThread = recovery.find((row) => row.type === "connection-open")!.threadId;
        expect(recoveredThread).not.toBe(failedThread);
      }
    }
  });

  it("retires actual workers with malformed protocol/structural results before restore, recreation, and shutdown", async () => {
    await shutdownWeekProjection();
    const { WeekProjectionService } = await import("../../src/weekService.js");
    const { resolveWeek } = await import("../../src/weekTime.js");
    const week = resolveWeek("2033-12-26", "UTC")!;

    for (const mode of ["protocol", "structural"] as const) {
      setMode(mode);
      const lifecycle: Array<{ type: "create" | "exit"; threadId: number; code?: number }> = [];
      const factory = (url: URL, options: ConstructorParameters<typeof Worker>[1]) => {
        const worker = new Worker(url, options);
        const workerThread = worker.threadId;
        lifecycle.push({ type: "create", threadId: workerThread });
        worker.once("exit", (code) => lifecycle.push({ type: "exit", threadId: workerThread, code }));
        return worker;
      };
      const service = new WeekProjectionService(path.join(process.env.DATA_DIR!, "app.db"), undefined, factory);

      await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "failed" });
      const failedThread = lifecycle.find((row) => row.type === "create")!.threadId;
      await service.beginRestore();
      expect(lifecycle.some((row) => row.type === "exit" && row.threadId === failedThread)).toBe(true);
      service.finishRestore(false, true);

      setMode("observe");
      await expect(service.requestPage(week, null)).resolves.toMatchObject({ records: expect.any(Array) });
      const recoveredThread = lifecycle.filter((row) => row.type === "create").at(-1)!.threadId;
      expect(recoveredThread).not.toBe(failedThread);
      expect(lifecycle.findIndex((row) => row.type === "exit" && row.threadId === failedThread))
        .toBeLessThan(lifecycle.findIndex((row) => row.type === "create" && row.threadId === recoveredThread));

      await service.shutdown();
      expect(lifecycle.some((row) => row.type === "exit" && row.threadId === recoveredThread && row.code === 0)).toBe(true);
    }
  });

  it("orders actual production-worker termination before recreation, restore, and shutdown", async () => {
    await shutdownWeekProjection();
    setMode("observe");
    const { WeekProjectionService } = await import("../../src/weekService.js");
    const { resolveWeek } = await import("../../src/weekTime.js");
    const week = resolveWeek("2033-12-26", "UTC")!;
    const lifecycle: Array<{ type: "create" | "terminate" | "exit"; threadId: number; code?: number }> = [];
    let faultNext = true;
    const factory = (url: URL, options: ConstructorParameters<typeof Worker>[1]) => {
      const worker = new Worker(url, options);
      const workerThread = worker.threadId;
      lifecycle.push({ type: "create", threadId: workerThread });
      worker.once("exit", (code) => lifecycle.push({ type: "exit", threadId: workerThread, code }));
      const postMessage = worker.postMessage.bind(worker);
      (worker as unknown as { postMessage(value: unknown): void }).postMessage = (value: unknown) => {
        if (faultNext && (value as { type?: string }).type === "query") {
          faultNext = false;
          lifecycle.push({ type: "terminate", threadId: workerThread });
          void worker.terminate();
          return;
        }
        postMessage(value);
      };
      return worker;
    };
    const service = new WeekProjectionService(path.join(process.env.DATA_DIR!, "app.db"), undefined, factory);

    await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "failed" });
    await expect(service.requestPage(week, null)).resolves.toMatchObject({ records: expect.any(Array) });
    const first = lifecycle.find((row) => row.type === "terminate")!.threadId;
    const second = lifecycle.find((row) => row.type === "create" && row.threadId !== first)!.threadId;
    expect(lifecycle.findIndex((row) => row.type === "exit" && row.threadId === first))
      .toBeLessThan(lifecycle.findIndex((row) => row.type === "create" && row.threadId === second));

    const restoreStart = events().length;
    await service.beginRestore();
    const restoreRows = events().slice(restoreStart);
    const closeEnd = restoreRows.findIndex((row) => row.type === "connection-close-end" && row.threadId === second);
    const closedMessage = restoreRows.findIndex((row) => row.type === "worker-message" &&
      row.threadId === second && row.messageType === "closed");
    expect(closeEnd).toBeGreaterThanOrEqual(0);
    expect(closedMessage).toBeGreaterThan(closeEnd);
    expect(lifecycle.some((row) => row.type === "exit" && row.threadId === second && row.code === 0)).toBe(true);
    service.finishRestore(false, true);

    await service.requestPage(week, null);
    const third = lifecycle.filter((row) => row.type === "create").at(-1)!.threadId;
    await service.shutdown();
    expect(events().slice(restoreStart).some((row) =>
      row.type === "connection-close-end" && row.threadId === third)).toBe(true);
    expect(lifecycle.some((row) => row.type === "exit" && row.threadId === third && row.code === 0)).toBe(true);

    faultNext = true;
    await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "failed" });
    const latestFault = lifecycle.filter((row) => row.type === "terminate").at(-1)!.threadId;
    await service.beginRestore();
    expect(lifecycle.some((row) => row.type === "exit" && row.threadId === latestFault)).toBe(true);
    service.finishRestore(false, true);
  });
});
