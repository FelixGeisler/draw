import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  FOREST_PAGE_SIZE,
  ForestGenerationLoader,
  StaleForestGenerationError,
  currentTreeScale,
  decodeCurrentTimer,
  decodeForestPage,
  forestWriteMayHaveCommitted,
  type CurrentTimer,
  type ForestPage,
} from "./forest";

const START = "2026-01-02T03:04:05.006Z";
const END = "2026-01-02T03:04:05.006Z";

function row(id: number, overrides: Record<string, unknown> = {}) {
  return { id, startedAt: START, endedAt: END, endReason: "done", ...overrides };
}

function page(count: number, start = count + 1, nextBeforeId: number | null = null) {
  return { trees: Array.from({ length: count }, (_, index) => row(start - index)), nextBeforeId };
}

function timer(overrides: { entry?: Record<string, unknown>; task?: Record<string, unknown> } = {}) {
  return {
    entry: { id: 7, taskId: 11, startedAt: START, endedAt: null, ...overrides.entry },
    task: {
      id: 11,
      title: "kept for existing timer consumers",
      categoryId: 3,
      impact: 4,
      effortMinutes: null,
      goalId: null,
      status: "open",
      ...overrides.task,
    },
  };
}

describe("strict forest page decoder", () => {
  it("accepts zero duration and the exact 99/100-row nullable lookahead relationship", () => {
    expect(decodeForestPage(page(1, 9), null).trees[0]).toEqual(row(9));
    expect(decodeForestPage(page(99, 100), null).trees).toHaveLength(99);
    const hundred = page(100, 200, 101);
    expect(decodeForestPage(hundred, null)).toEqual(hundred);
    expect(decodeForestPage(page(100, 200, null), null).nextBeforeId).toBeNull();
  });

  it.each([
    ["extra top key", { ...page(0), extra: true }, null],
    ["missing top key", { trees: [] }, null],
    ["101 rows", page(101, 200), null],
    ["extra row key", { trees: [{ ...row(3), task: "private" }], nextBeforeId: null }, null],
    ["duplicate ids", { trees: [row(3), row(3)], nextBeforeId: null }, null],
    ["ascending ids", { trees: [row(2), row(3)], nextBeforeId: null }, null],
    ["unsafe id", { trees: [row(Number.MAX_SAFE_INTEGER + 1)], nextBeforeId: null }, null],
    ["invalid calendar timestamp", { trees: [row(3, { startedAt: "2026-02-30T00:00:00.000Z" })], nextBeforeId: null }, null],
    ["out-of-contract year zero", { trees: [row(3, { startedAt: "0000-01-01T00:00:00.000Z" })], nextBeforeId: null }, null],
    ["noncanonical timestamp", { trees: [row(3, { endedAt: "2026-01-02T03:04:05Z" })], nextBeforeId: null }, null],
    ["negative interval", { trees: [row(3, { startedAt: "2026-01-02T03:04:05.007Z" })], nextBeforeId: null }, null],
    ["unknown reason", { trees: [row(3, { endReason: "lost" })], nextBeforeId: null }, null],
    ["id not below cursor", { trees: [row(10)], nextBeforeId: null }, 10],
    ["short page cursor", { trees: [row(3)], nextBeforeId: 3 }, null],
    ["wrong lookahead cursor", page(100, 200, 102), null],
  ])("rejects the whole response for %s", (_name, value, cursor) => {
    expect(() => decodeForestPage(value, cursor)).toThrow("Invalid forest response");
  });
});

describe("shared strict current-timer decoder", () => {
  it("accepts only null or the complete existing timer shape", () => {
    expect(decodeCurrentTimer(null)).toBeNull();
    expect(decodeCurrentTimer(timer())).toEqual(timer());
  });

  it.each([
    ["extra top key", { ...timer(), extra: true }],
    ["extra entry key", timer({ entry: { extra: true } })],
    ["extra task key", timer({ task: { description: "must not enter this wire shape" } })],
    ["mismatched task", timer({ task: { id: 12 } })],
    ["unsafe entry id", timer({ entry: { id: Number.MAX_SAFE_INTEGER + 1 } })],
    ["noncanonical start", timer({ entry: { startedAt: "2026-01-02T03:04:05Z" } })],
    ["closed current", timer({ entry: { endedAt: END } })],
    ["bad category", timer({ task: { categoryId: 0 } })],
    ["bad impact", timer({ task: { impact: 6 } })],
    ["fractional effort", timer({ task: { effortMinutes: 1.5 } })],
    ["bad goal", timer({ task: { goalId: -1 } })],
    ["bad status", timer({ task: { status: "deleted" } })],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeCurrentTimer(value)).toThrow("Invalid current timer response");
  });
});

describe("atomic paired publication and generations", () => {
  it("publishes only after both complete validated sources resolve", async () => {
    let resolveCurrent!: (value: CurrentTimer | null) => void;
    const current = new Promise<CurrentTimer | null>((resolve) => { resolveCurrent = resolve; });
    const loader = new ForestGenerationLoader(
      async () => decodeForestPage(page(1, 9), null),
      async () => current,
    );
    const result = loader.load(null);
    let settled = false;
    void result.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveCurrent(decodeCurrentTimer(timer()));
    await expect(result).resolves.toMatchObject({ kind: "published", page: { trees: [{ id: 9 }] } });
  });

  it("rejects the complete generation when either source fails and aborts the pending sibling", async () => {
    let pageAborted = false;
    const loader = new ForestGenerationLoader(
      (_cursor, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        pageAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true })),
      async () => { throw new Error("bad current"); },
    );
    await expect(loader.load(null)).rejects.toThrow("bad current");
    expect(pageAborted).toBe(true);
  });

  it("cancels and rejects a late older generation so it cannot overwrite Newest", async () => {
    const pageResolvers: Array<(value: ForestPage) => void> = [];
    const loader = new ForestGenerationLoader(
      () => new Promise((resolve) => pageResolvers.push(resolve)),
      async () => null,
    );
    const older = loader.load(50);
    const newest = loader.load(null);
    pageResolvers[1](decodeForestPage(page(1, 90), null));
    await expect(newest).resolves.toMatchObject({ requestedBeforeId: null, page: { trees: [{ id: 90 }] } });
    pageResolvers[0](decodeForestPage(page(1, 40), 50));
    await expect(older).rejects.toBeInstanceOf(StaleForestGenerationError);
  });

  it("retains no appended page state: every publication is one bounded replacement", async () => {
    const loadPage = vi.fn(async (cursor: number | null) =>
      decodeForestPage(cursor === null ? page(100, 200, 101) : page(99, 100), cursor),
    );
    const loader = new ForestGenerationLoader(loadPage, async () => null);
    const newest = await loader.load(null);
    const older = await loader.load(newest.page.nextBeforeId);
    expect(newest.page.trees).toHaveLength(FOREST_PAGE_SIZE);
    expect(older.page.trees).toHaveLength(99);
    expect(older).not.toHaveProperty("previous");
    expect(loadPage).toHaveBeenNthCalledWith(2, 101, expect.any(AbortSignal));
  });
});

describe("growth and mutation recovery policy", () => {
  it("uses the exact monotone asymptotic growth formula", () => {
    expect(currentTreeScale(-2)).toBe(0.72);
    expect(currentTreeScale(0)).toBe(0.72);
    expect(currentTreeScale(30)).toBeCloseTo(0.86, 12);
    expect(currentTreeScale(60)).toBeGreaterThan(currentTreeScale(30));
    expect(currentTreeScale(1_000_000)).toBeLessThan(1);
    expect(currentTreeScale(Number.NaN)).toBe(0.72);
  });

  it("resets ambiguous/race outcomes but preserves validated pre-write 4xx failures", () => {
    expect(forestWriteMayHaveCommitted(new TypeError("response lost"))).toBe(true);
    expect(forestWriteMayHaveCommitted(new ApiError(500, "post-request failure"))).toBe(true);
    expect(forestWriteMayHaveCommitted(new ApiError(404, "completion race"), [404, 409])).toBe(true);
    expect(forestWriteMayHaveCommitted(new ApiError(409, "completion race"), [404, 409])).toBe(true);
    expect(forestWriteMayHaveCommitted(new ApiError(400, "pre-write validation"))).toBe(false);
    expect(forestWriteMayHaveCommitted(new ApiError(404, "split pre-write"))).toBe(false);
  });
});
