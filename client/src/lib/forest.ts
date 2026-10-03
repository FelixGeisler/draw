import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Task } from "../api/types";

export const FOREST_PAGE_SIZE = 100;
export const FOREST_QUERY_KEY = ["forest"] as const;

export interface ForestTree {
  id: number;
  startedAt: string;
  endedAt: string;
  endReason: "done" | "stop";
}

export interface ForestPage {
  trees: ForestTree[];
  nextBeforeId: number | null;
}

export interface CurrentTimer {
  entry: { id: number; taskId: number; startedAt: string; endedAt: null };
  task: Pick<Task, "id" | "title" | "categoryId" | "impact" | "effortMinutes" | "goalId" | "status">;
}

export interface PublishedForest {
  kind: "published";
  page: ForestPage;
  current: CurrentTimer | null;
  requestedBeforeId: number | null;
}

export interface ClearedForest {
  kind: "cleared";
}

export type ForestState = PublishedForest | ClearedForest;
export const CLEARED_FOREST: ClearedForest = Object.freeze({ kind: "cleared" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < -62_135_596_800_000 || parsed > 253_402_300_799_999) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

export function decodeForestPage(value: unknown, requestedBeforeId: number | null): ForestPage {
  if (!isRecord(value) || !hasExactKeys(value, ["trees", "nextBeforeId"]) || !Array.isArray(value.trees)) {
    throw new Error("Invalid forest response");
  }
  if (value.trees.length > FOREST_PAGE_SIZE) throw new Error("Invalid forest response");

  let previous = requestedBeforeId ?? Number.MAX_SAFE_INTEGER + 1;
  const trees = value.trees.map((candidate): ForestTree => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["id", "startedAt", "endedAt", "endReason"])) {
      throw new Error("Invalid forest response");
    }
    const start = parseCanonicalTimestamp(candidate.startedAt);
    const end = parseCanonicalTimestamp(candidate.endedAt);
    if (
      !positiveSafeInteger(candidate.id) ||
      candidate.id >= previous ||
      start === null ||
      end === null ||
      end < start ||
      (candidate.endReason !== "done" && candidate.endReason !== "stop")
    ) {
      throw new Error("Invalid forest response");
    }
    previous = candidate.id;
    return {
      id: candidate.id,
      startedAt: candidate.startedAt as string,
      endedAt: candidate.endedAt as string,
      endReason: candidate.endReason,
    };
  });

  const next = value.nextBeforeId;
  const validNext =
    next === null ||
    (trees.length === FOREST_PAGE_SIZE && positiveSafeInteger(next) && next === trees[trees.length - 1]?.id);
  if (!validNext || (trees.length < FOREST_PAGE_SIZE && next !== null)) {
    throw new Error("Invalid forest response");
  }
  return { trees, nextBeforeId: next as number | null };
}

export function decodeCurrentTimer(value: unknown): CurrentTimer | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["entry", "task"]) || !isRecord(value.entry) || !isRecord(value.task)) {
    throw new Error("Invalid current timer response");
  }
  const entry = value.entry;
  const task = value.task;
  if (
    !hasExactKeys(entry, ["id", "taskId", "startedAt", "endedAt"]) ||
    !hasExactKeys(task, ["id", "title", "categoryId", "impact", "effortMinutes", "goalId", "status"]) ||
    !positiveSafeInteger(entry.id) ||
    !positiveSafeInteger(entry.taskId) ||
    parseCanonicalTimestamp(entry.startedAt) === null ||
    entry.endedAt !== null ||
    !positiveSafeInteger(task.id) ||
    task.id !== entry.taskId ||
    typeof task.title !== "string" ||
    !positiveSafeInteger(task.categoryId) ||
    !Number.isInteger(task.impact) ||
    (task.impact as number) < 1 ||
    (task.impact as number) > 5 ||
    !(task.effortMinutes === null || Number.isInteger(task.effortMinutes)) ||
    !(task.goalId === null || positiveSafeInteger(task.goalId)) ||
    (task.status !== "open" && task.status !== "done" && task.status !== "archived")
  ) {
    throw new Error("Invalid current timer response");
  }
  return value as unknown as CurrentTimer;
}

export async function fetchForestPage(beforeId: number | null, signal?: AbortSignal): Promise<ForestPage> {
  const target = beforeId === null ? "/api/forest" : `/api/forest?beforeId=${beforeId}`;
  return decodeForestPage(await api.get<unknown>(target, signal), beforeId);
}

export async function fetchCurrentTimer(signal?: AbortSignal): Promise<CurrentTimer | null> {
  return decodeCurrentTimer(await api.get<unknown>("/api/timer/current", signal));
}

export class StaleForestGenerationError extends Error {
  constructor() {
    super("Stale forest generation");
  }
}

type PageLoader = (beforeId: number | null, signal?: AbortSignal) => Promise<ForestPage>;
type TimerLoader = (signal?: AbortSignal) => Promise<CurrentTimer | null>;

/** Owns the single publishable generation; validation happens inside both loaders before either result is exposed. */
export class ForestGenerationLoader {
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly publicationGenerations = new WeakMap<PublishedForest, number>();

  constructor(
    private readonly pageLoader: PageLoader = fetchForestPage,
    private readonly timerLoader: TimerLoader = fetchCurrentTimer,
  ) {}

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  epoch(): number {
    return this.generation;
  }

  isEpochCurrent(epoch: number): boolean {
    return epoch === this.generation;
  }

  /**
   * The check and replacement happen synchronously inside QueryClient's actual
   * cache write. A reset can therefore invalidate a result even after load()
   * validated it but before TanStack Query or navigation publishes it.
   */
  publishIfCurrent(previous: ForestState | undefined, candidate: PublishedForest): ForestState {
    return this.publicationGenerations.get(candidate) === this.generation
      ? candidate
      : previous ?? CLEARED_FOREST;
  }

  async load(beforeId: number | null, outerSignal?: AbortSignal): Promise<PublishedForest> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    else outerSignal?.addEventListener("abort", abort, { once: true });
    try {
      const [page, current] = await Promise.all([
        this.pageLoader(beforeId, controller.signal),
        this.timerLoader(controller.signal),
      ]);
      if (generation !== this.generation || controller.signal.aborted) throw new StaleForestGenerationError();
      const publication: PublishedForest = { kind: "published", page, current, requestedBeforeId: beforeId };
      this.publicationGenerations.set(publication, generation);
      return publication;
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) throw new StaleForestGenerationError();
      // One failed half invalidates the pair; stop the still-pending sibling.
      controller.abort();
      throw error;
    } finally {
      outerSignal?.removeEventListener("abort", abort);
      if (generation === this.generation) this.controller = null;
    }
  }
}

const loaders = new WeakMap<QueryClient, ForestGenerationLoader>();

export function forestLoader(queryClient: QueryClient): ForestGenerationLoader {
  let loader = loaders.get(queryClient);
  if (!loader) {
    loader = new ForestGenerationLoader();
    loaders.set(queryClient, loader);
  }
  return loader;
}

/** Destructive reset used only by the accepted source-event matrix. */
export function resetForest(queryClient: QueryClient): void {
  forestLoader(queryClient).cancel();
  void queryClient.cancelQueries({ queryKey: FOREST_QUERY_KEY, exact: true }, { revert: false });
  queryClient.setQueryData<ForestState>(FOREST_QUERY_KEY, CLEARED_FOREST);
  void queryClient.invalidateQueries({ queryKey: FOREST_QUERY_KEY, exact: true, refetchType: "active" });
}

/** A transport/server result can hide a committed write; validated pre-write 4xx responses do not. */
export function forestWriteMayHaveCommitted(error: unknown, raceStatuses: readonly number[] = []): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || raceStatuses.includes(error.status);
}

export function currentTreeScale(elapsedMinutes: number): number {
  const minutes = Number.isFinite(elapsedMinutes) ? Math.max(0, elapsedMinutes) : 0;
  return 0.72 + (0.28 * minutes) / (minutes + 30);
}
