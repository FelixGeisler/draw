import { Worker } from "node:worker_threads";
import {
  WEEK_BODY_MAX_BYTES,
  decodeWeekResponse,
  isCanonicalInstant,
  type WeekResponse,
} from "../../shared/weekContract.js";
import { createWeekCursorCodec, WeekCursorError, type WeekCursorPosition } from "./weekCursor.js";
import type { ResolvedWeek } from "./weekTime.js";
import type {
  WeekWorkerFailure,
  WeekWorkerMessage,
  WeekWorkerRequest,
  WeekWorkerResult,
} from "./weekWorkerProtocol.js";

export type WeekServiceErrorCode = "busy" | "unavailable" | "failed";
export class WeekServiceError extends Error {
  constructor(readonly code: WeekServiceErrorCode) {
    super(code);
  }
}

export class WeekRestoreBusyError extends Error {
  constructor() {
    super("a Week request is active; retry restore after it finishes");
  }
}

export type WeekWorkerFactory = (url: URL, options: ConstructorParameters<typeof Worker>[1]) => Worker;

type WorkerSlot = {
  worker: Worker;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  request: null | {
    id: number;
    resolve: (result: WeekWorkerResult) => void;
    reject: (error: WeekServiceError) => void;
  };
  closedSeen: boolean;
  exited: boolean;
  exit: Promise<number>;
  resolveExit: (code: number) => void;
  retirement: Promise<void> | null;
};

function serviceError(code: WeekServiceErrorCode): WeekServiceError {
  return new WeekServiceError(code);
}

export class WeekProjectionService {
  readonly #cursor = createWeekCursorCodec();
  #slot: WorkerSlot | null = null;
  #busy = false;
  #restoreLease = false;
  #unavailable = false;
  #nextRequestId = 1;
  #idleWaiters: Array<() => void> = [];
  readonly #retiring = new Set<Promise<void>>();

  constructor(
    private readonly databasePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly workerFactory: WeekWorkerFactory = (url, options) => new Worker(url, options),
  ) {}

  decodeCursor(cursor: unknown, week: ResolvedWeek): WeekCursorPosition {
    return this.#cursor.decode(cursor, week);
  }

  #spawn(): WorkerSlot {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let resolveExit!: (code: number) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const worker = this.workerFactory(new URL("./weekWorker.ts", import.meta.url), {
      workerData: { databasePath: this.databasePath },
      execArgv: ["--import", "tsx"],
    });
    worker.unref();
    const slot: WorkerSlot = {
      worker,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      request: null,
      closedSeen: false,
      exited: false,
      exit,
      resolveExit,
      retirement: null,
    };
    worker.on("message", (message: WeekWorkerMessage) => {
      if (message.type === "ready") {
        if (!slot.readySettled) {
          slot.readySettled = true;
          slot.resolveReady();
        }
        return;
      }
      if (message.type === "closed") {
        slot.closedSeen = true;
        return;
      }
      if (!slot.request || slot.request.id !== message.id) return;
      const pending = slot.request;
      slot.request = null;
      if (message.type === "result") pending.resolve(message);
      else {
        pending.reject(serviceError(message.code));
        if (message.discard) void this.#retire(slot, true);
      }
    });
    const fault = () => {
      if (!slot.readySettled) {
        slot.readySettled = true;
        slot.rejectReady(serviceError("unavailable"));
      }
      const pending = slot.request;
      slot.request = null;
      pending?.reject(serviceError("failed"));
      void this.#retire(slot, true);
    };
    worker.once("error", fault);
    worker.once("exit", (code) => {
      slot.exited = true;
      slot.resolveExit(code);
      if (code !== 0 || (!slot.closedSeen && this.#slot === slot)) fault();
      if (this.#slot === slot) this.#slot = null;
    });
    return slot;
  }

  #retire(slot: WorkerSlot, terminate: boolean): Promise<void> {
    if (this.#slot === slot) this.#slot = null;
    if (!slot.retirement) {
      slot.retirement = slot.exit.then(() => undefined);
      this.#retiring.add(slot.retirement);
      void slot.retirement.finally(() => this.#retiring.delete(slot.retirement!));
    }
    if (terminate && !slot.exited) void slot.worker.terminate().catch(() => undefined);
    return slot.retirement;
  }

  async #awaitRetiring(): Promise<void> {
    while (this.#retiring.size > 0) await Promise.all([...this.#retiring]);
  }

  async #worker(): Promise<WorkerSlot> {
    await this.#awaitRetiring();
    let slot = this.#slot;
    if (!slot) {
      slot = this.#spawn();
      this.#slot = slot;
    }
    try {
      await slot.ready;
      return slot;
    } catch (error) {
      await this.#retire(slot, true);
      throw error;
    }
  }

  async #query(request: WeekWorkerRequest): Promise<WeekWorkerResult> {
    const slot = await this.#worker();
    return new Promise<WeekWorkerResult>((resolve, reject) => {
      if (slot.request) {
        reject(serviceError("failed"));
        return;
      }
      slot.request = { id: request.id, resolve, reject };
      try {
        slot.worker.postMessage(request);
      } catch {
        slot.request = null;
        reject(serviceError("failed"));
        void this.#retire(slot, true);
      }
    });
  }

  async requestPage(week: ResolvedWeek, cursor: WeekCursorPosition | null): Promise<WeekResponse> {
    if (this.#busy || this.#restoreLease) throw serviceError("busy");
    if (this.#unavailable) throw serviceError("unavailable");
    this.#busy = true;
    const requestNow = cursor?.requestNow ?? this.now().toISOString();
    if (!isCanonicalInstant(requestNow)) {
      this.#busy = false;
      throw serviceError("failed");
    }
    const request: WeekWorkerRequest = {
      type: "query",
      id: this.#nextRequestId++,
      week,
      requestNow,
      after: cursor
        ? { anchorMs: Date.parse(cursor.anchor), kindRank: cursor.kindRank, id: cursor.id }
        : null,
    };
    try {
      let result: WeekWorkerResult;
      try {
        result = await this.#query(request);
      } catch (error) {
        if (error instanceof WeekServiceError) throw error;
        throw serviceError("failed");
      }
      if (result.hasMore && result.last === null) throw serviceError("failed");
      const nextCursor = result.hasMore
        ? this.#cursor.encode(week, {
            requestNow,
            anchor: result.last!.anchor,
            kindRank: result.last!.kindRank,
            id: result.last!.id,
          })
        : null;
      const response: WeekResponse = {
        weekStart: week.weekStart,
        timezone: week.timezone,
        requestNow,
        records: result.records,
        nextCursor,
      };
      const encoded = JSON.stringify(response);
      if (Buffer.byteLength(encoded, "utf8") > WEEK_BODY_MAX_BYTES) throw serviceError("failed");
      const validated = decodeWeekResponse(JSON.parse(encoded) as unknown, week);
      if (nextCursor) {
        const rebound = this.#cursor.decode(nextCursor, week);
        if (
          rebound.requestNow !== requestNow || rebound.anchor !== result.last!.anchor ||
          rebound.kindRank !== result.last!.kindRank || rebound.id !== result.last!.id
        ) throw serviceError("failed");
      }
      return validated;
    } finally {
      this.#busy = false;
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  async #closeWorker(): Promise<void> {
    await this.#awaitRetiring();
    const slot = this.#slot;
    if (!slot) return;
    try {
      await slot.ready;
    } catch {
      await this.#retire(slot, true);
      throw serviceError("failed");
    }
    if (slot.request) throw serviceError("failed");
    try {
      slot.worker.postMessage({ type: "close" });
    } catch {
      await this.#retire(slot, true);
      throw serviceError("failed");
    }
    const retirement = this.#retire(slot, false);
    const code = await slot.exit;
    await retirement;
    if (code !== 0 || !slot.closedSeen) throw serviceError("failed");
  }

  /** The lease is set synchronously before the first await. */
  async beginRestore(): Promise<void> {
    if (this.#busy || this.#restoreLease) throw new WeekRestoreBusyError();
    this.#restoreLease = true;
    try {
      await this.#closeWorker();
    } catch (error) {
      this.#restoreLease = false;
      throw error;
    }
  }

  finishRestore(committed: boolean, liveReopenSucceeded: boolean): void {
    if (!this.#restoreLease) throw new Error("Week restore lease is not held");
    // The commit point invalidates old cursors even when the subsequent live
    // reopen fails. A pre-commit failure retains the key. In either case no
    // worker may reopen until the complete live reopen/validation is proven.
    if (committed) this.#cursor.rotate();
    this.#unavailable = !liveReopenSucceeded;
    this.#restoreLease = false;
  }

  async shutdown(): Promise<void> {
    this.#restoreLease = true;
    if (this.#busy) {
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    }
    try {
      await this.#closeWorker();
    } finally {
      this.#restoreLease = false;
    }
  }
}

export { WeekCursorError };
