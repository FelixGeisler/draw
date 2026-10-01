import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { WeekProjectionService, type WeekWorkerFactory } from "../../src/weekService.js";
import { resolveWeek } from "../../src/weekTime.js";
import type { WeekWorkerMessage, WeekWorkerRequest } from "../../src/weekWorkerProtocol.js";

class ControlledWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  readonly options: ConstructorParameters<typeof Worker>[1];
  query: WeekWorkerRequest | null = null;
  exited = false;
  private resolveTermination!: (code: number) => void;
  readonly termination = new Promise<number>((resolve) => { this.resolveTermination = resolve; });

  constructor(options: ConstructorParameters<typeof Worker>[1]) {
    super();
    this.options = options;
    queueMicrotask(() => this.emit("message", { type: "ready" } satisfies WeekWorkerMessage));
  }

  unref() { return this; }

  postMessage(message: unknown) {
    this.posted.push(message);
    if ((message as { type?: string }).type === "close") {
      queueMicrotask(() => {
        this.emit("message", { type: "closed" } satisfies WeekWorkerMessage);
        this.exit(0);
      });
      return;
    }
    this.query = message as WeekWorkerRequest;
  }

  finish() {
    const request = this.query!;
    this.query = null;
    this.emit("message", {
      type: "result", id: request.id, records: [], hasMore: false, last: null,
    } satisfies WeekWorkerMessage);
  }

  discard() {
    const request = this.query!;
    this.query = null;
    this.emit("message", {
      type: "failure", id: request.id, code: "failed", discard: true,
    } satisfies WeekWorkerMessage);
  }

  malformedProtocol() {
    const request = this.query!;
    this.query = null;
    this.emit("message", { type: "unexpected", id: request.id });
  }

  structurallyInvalidResult() {
    const request = this.query!;
    this.query = null;
    this.emit("message", {
      type: "result", id: request.id, records: [], hasMore: true, last: null,
    } satisfies WeekWorkerMessage);
  }

  terminate() { return this.termination; }

  exit(code: number) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
    this.resolveTermination(code);
  }
}

function harness() {
  const workers: ControlledWorker[] = [];
  const factory: WeekWorkerFactory = ((_url, options) => {
    const worker = new ControlledWorker(options);
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const service = new WeekProjectionService(
    "C:/fixture/app.db",
    () => new Date("2026-10-29T12:00:00.000Z"),
    factory,
  );
  return { service, workers };
}

const week = resolveWeek("2026-10-26", "Europe/Berlin")!;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Week worker lifecycle ownership", () => {
  it("creates lazily, reuses one worker sequentially, admits one query, and closes on shutdown", async () => {
    const { service, workers } = harness();
    expect(workers).toHaveLength(0);

    const first = service.requestPage(week, null);
    await tick();
    expect(workers).toHaveLength(1);
    expect(workers[0].options).toMatchObject({
      workerData: { databasePath: "C:/fixture/app.db" },
      execArgv: ["--import", "tsx"],
    });
    await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "busy" });
    workers[0].finish();
    await expect(first).resolves.toMatchObject({ records: [] });

    const second = service.requestPage(week, null);
    await tick();
    expect(workers).toHaveLength(1);
    workers[0].finish();
    await second;

    await service.shutdown();
    expect(workers[0].posted.at(-1)).toEqual({ type: "close" });
    expect(workers[0].exited).toBe(true);
  });

  it("keeps admission busy when a caller disconnects until synchronous worker completion", async () => {
    const { service, workers } = harness();
    const abandoned = service.requestPage(week, null);
    await tick();
    // Dropping the caller's ownership provides no SQLite interruption signal.
    await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "busy" });
    expect(workers).toHaveLength(1);
    workers[0].finish();
    await abandoned;
    const next = service.requestPage(week, null);
    await tick();
    workers[0].finish();
    await next;
    await service.shutdown();
  });

  it("retains a discarded worker until exit and blocks immediate recreation", async () => {
    const { service, workers } = harness();
    const failed = service.requestPage(week, null);
    await tick();
    workers[0].discard();
    await expect(failed).rejects.toMatchObject({ code: "failed" });

    const recreation = service.requestPage(week, null);
    await tick();
    expect(workers).toHaveLength(1);

    workers[0].exit(1);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].finish();
    await recreation;
    await service.shutdown();
  });

  it("retires malformed protocol and structural results before later ownership", async () => {
    for (const fault of ["protocol", "structural"] as const) {
      const { service, workers } = harness();
      const failed = service.requestPage(week, null);
      const failure = expect(failed).rejects.toMatchObject({ code: "failed" });
      await tick();
      if (fault === "protocol") workers[0].malformedProtocol();
      else workers[0].structurallyInvalidResult();
      await tick();

      let followUp: Promise<unknown>;
      if (fault === "protocol") {
        await failure;
        followUp = service.requestPage(week, null);
        await tick();
        expect(workers).toHaveLength(1);
        workers[0].exit(1);
      } else {
        workers[0].exit(1);
        await failure;
        followUp = service.requestPage(week, null);
      }
      await tick();
      expect(workers).toHaveLength(2);
      workers[1].finish();
      await followUp;
      await service.shutdown();
    }
  });

  it("awaits fault retirement before restore and latches unavailable after failed live reopen", async () => {
    const { service, workers } = harness();
    const failed = service.requestPage(week, null);
    await tick();
    workers[0].emit("error", new Error("injected worker fault"));
    await expect(failed).rejects.toMatchObject({ code: "failed" });

    const restore = service.beginRestore();
    await tick();
    let settled = false;
    void restore.then(() => { settled = true; });
    expect(settled).toBe(false);
    workers[0].exit(1);
    await restore;
    service.finishRestore(false, false);

    await expect(service.requestPage(week, null)).rejects.toMatchObject({ code: "unavailable" });
    expect(workers).toHaveLength(1);

    await service.beginRestore();
    service.finishRestore(false, true);
    const recovered = service.requestPage(week, null);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].finish();
    await recovered;
    await service.shutdown();
  });
});
