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
};

function serviceError(code: WeekServiceErrorCode): WeekServiceError {
  return new WeekServiceError(code);
}

export class WeekProjectionService {
  readonly #cursor = createWeekCursorCodec();
  #slot: WorkerSlot | null = null;
  #busy = false;
  #restoreLease = false;
  #nextRequestId = 1;
  #idleWaiters: Array<() => void> = [];

  constructor(
    private readonly databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  decodeCursor(cursor: unknown, week: ResolvedWeek): WeekCursorPosition {
    return this.#cursor.decode(cursor, week);
  }

  #spawn(): WorkerSlot {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = new Worker(new URL("./weekWorker.ts", import.meta.url), {
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
        if (message.discard) {
          if (this.#slot === slot) this.#slot = null;
          void slot.worker.terminate();
        }
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
      if (this.#slot === slot) this.#slot = null;
    };
    worker.once("error", fault);
    worker.once("exit", (code) => {
      if (code !== 0 || (!slot.closedSeen && this.#slot === slot)) fault();
      if (this.#slot === slot) this.#slot = null;
    });
    return slot;
  }

  async #worker(): Promise<WorkerSlot> {
    let slot = this.#slot;
    if (!slot) {
      slot = this.#spawn();
      this.#slot = slot;
    }
    try {
      await slot.ready;
      return slot;
    } catch (error) {
      if (this.#slot === slot) this.#slot = null;
      void slot.worker.terminate();
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
      }
    });
  }

  async requestPage(week: ResolvedWeek, cursor: WeekCursorPosition | null): Promise<WeekResponse> {
    if (this.#busy || this.#restoreLease) throw serviceError("busy");
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
      const validated = decodeWeekResponse(JSON.parse(encoded) as unknown);
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
    const slot = this.#slot;
    if (!slot) return;
    await slot.ready;
    if (slot.request) throw serviceError("failed");
    const exit = new Promise<number>((resolve) => slot.worker.once("exit", resolve));
    slot.worker.postMessage({ type: "close" });
    const code = await exit;
    if (code !== 0 || !slot.closedSeen) throw serviceError("failed");
    if (this.#slot === slot) this.#slot = null;
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

  finishRestore(committed: boolean): void {
    if (!this.#restoreLease) throw new Error("Week restore lease is not held");
    if (committed) this.#cursor.rotate();
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
