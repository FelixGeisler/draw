import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { FOREST_QUERY_KEY, type ForestState } from "../lib/forest";
import { deleteGoalMutation } from "./useGoals";
import {
  createTaskMutation,
  deleteTaskMutation,
  reorderSubtaskMutation,
  splitTaskMutation,
  updateTaskMutation,
} from "./useTasks";
import { startTimerMutation, stopTimerMutation } from "./useTimer";

function priorForest(): ForestState {
  return {
    kind: "published",
    requestedBeforeId: 101,
    current: null,
    page: { trees: [], nextBeforeId: null },
  };
}

function clientWithForest(): { qc: QueryClient; previous: ForestState } {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const previous = priorForest();
  qc.setQueryData(FOREST_QUERY_KEY, previous);
  return { qc, previous };
}

function response(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(result: Response | Error): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  }));
}

function expectCleared(qc: QueryClient): void {
  expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual({ kind: "cleared" });
}

afterEach(() => vi.unstubAllGlobals());

describe("real forest producer mutation options", () => {
  it("clears after Start success but preserves the validated snapshot on failed Start", async () => {
    {
      installFetch(response({ ok: true }));
      const { qc } = clientWithForest();
      await new MutationObserver(qc, startTimerMutation(qc)).mutate(7);
      expectCleared(qc);
    }
    {
      installFetch(response({ error: "invalid task" }, 400));
      const { qc, previous } = clientWithForest();
      await expect(new MutationObserver(qc, startTimerMutation(qc)).mutate(7)).rejects.toBeInstanceOf(ApiError);
      expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
    }
  });

  it.each([
    ["success", response({ ok: true })],
    ["404 race", response({ error: "already stopped" }, 404)],
    ["validated 400 settlement", response({ error: "no timer" }, 400)],
    ["transport settlement", new TypeError("response lost")],
  ])("clears after every Stop %s", async (_name, result) => {
    installFetch(result);
    const { qc } = clientWithForest();
    const mutation = new MutationObserver(qc, stopTimerMutation(qc)).mutate(undefined);
    if (result instanceof Error || result.status >= 400) await expect(mutation).rejects.toThrow();
    else await mutation;
    expectCleared(qc);
  });

  it.each([
    ["direct completion", { task: {}, recurring: false }],
    ["recurring completion", { task: {}, recurring: true }],
    ["archive that may complete a parent", { task: {}, parentCompletion: { task: {} } }],
  ])("clears after successful %s", async (name, body) => {
    installFetch(response(body));
    const { qc } = clientWithForest();
    const status = name.startsWith("archive") ? "archived" : "done";
    await new MutationObserver(qc, updateTaskMutation(qc)).mutate({ id: 7, status });
    expectCleared(qc);
  });

  it.each([404, 409])("clears after a completion %i race", async (status) => {
    installFetch(response({ error: "completion race" }, status));
    const { qc } = clientWithForest();
    await expect(
      new MutationObserver(qc, updateTaskMutation(qc)).mutate({ id: 7, status: "done" }),
    ).rejects.toBeInstanceOf(ApiError);
    expectCleared(qc);
  });

  it("clears completion/archive ambiguity but preserves proven pre-write 4xx failures", async () => {
    for (const status of ["done", "archived"] as const) {
      installFetch(new TypeError("response lost"));
      const ambiguous = clientWithForest();
      await expect(
        new MutationObserver(ambiguous.qc, updateTaskMutation(ambiguous.qc)).mutate({ id: 7, status }),
      ).rejects.toThrow("response lost");
      expectCleared(ambiguous.qc);

      installFetch(response({ error: "pre-write validation" }, 400));
      const rejected = clientWithForest();
      await expect(
        new MutationObserver(rejected.qc, updateTaskMutation(rejected.qc)).mutate({ id: 7, status }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(rejected.qc.getQueryData(FOREST_QUERY_KEY)).toEqual(rejected.previous);
    }
  });

  it.each([
    ["success", response({ ok: true }), true],
    ["404 race", response({ error: "already deleted" }, 404), true],
    ["ambiguous transport", new TypeError("response lost"), true],
    ["pre-write 400", response({ error: "invalid" }, 400), false],
  ])("handles delete %s according to the approved matrix", async (_name, result, clears) => {
    installFetch(result);
    const { qc, previous } = clientWithForest();
    const mutation = new MutationObserver(qc, deleteTaskMutation(qc)).mutate(7);
    if (result instanceof Error || result.status >= 400) await expect(mutation).rejects.toThrow();
    else await mutation;
    if (clears) expectCleared(qc);
    else expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
  });

  it.each([
    ["success", response([]), true],
    ["ambiguous transport", new TypeError("response lost"), true],
    ["ambiguous server result", response({ error: "unknown result" }, 500), true],
    ["pre-write 400", response({ error: "invalid parts" }, 400), false],
  ])("handles split %s according to the approved matrix", async (_name, result, clears) => {
    installFetch(result);
    const { qc, previous } = clientWithForest();
    const mutation = new MutationObserver(qc, splitTaskMutation(qc)).mutate({
      id: 7,
      parts: [
        { title: "A", effortMinutes: 5 },
        { title: "B", effortMinutes: 5 },
      ],
    });
    if (result instanceof Error || result.status >= 400) await expect(mutation).rejects.toThrow();
    else await mutation;
    if (clears) expectCleared(qc);
    else expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
  });

  it.each([
    ["title/estimate/category/goal/fixed-slot edit", updateTaskMutation, { id: 7, title: "Edited", effortMinutes: 20, categoryId: 2, goalId: 3, fixedSlot: null }],
    ["reparent", updateTaskMutation, { id: 7, parentId: 9 }],
    ["reopen/unarchive", updateTaskMutation, { id: 7, status: "open" }],
    ["create", createTaskMutation, { title: "New", categoryId: 2 }],
    ["reorder", reorderSubtaskMutation, { id: 7, beforeId: null }],
    ["goal deletion", deleteGoalMutation, 3],
  ])("does not reset solely for %s", async (_name, options, variables) => {
    installFetch(response({ task: {}, ok: true }));
    const { qc, previous } = clientWithForest();
    const observer = new MutationObserver(qc, options(qc) as never);
    await observer.mutate(variables as never);
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
  });
});
