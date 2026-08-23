import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { claimAchievementMutation } from "./useGamification";
import {
  invalidateTaskMutationQueries,
  taskMutationCanChangeCompletion,
} from "./useTasks";
import { stopTimerMutation } from "./useTimer";

vi.mock("../api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/client")>();
  return { ...mod, api: { ...mod.api, post: vi.fn() } };
});
const postMock = vi.mocked(api.post);

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) =>
    JSON.stringify((call[0] as { queryKey: unknown[] }).queryKey),
  );
}

describe("Gold producer cache invalidation", () => {
  beforeEach(() => postMock.mockReset());

  it("selects only task writes that can create/remove a completion owner", () => {
    expect(taskMutationCanChangeCompletion("create", { title: "root" })).toBe(false);
    expect(taskMutationCanChangeCompletion("create", { parentId: 7 })).toBe(true);
    expect(taskMutationCanChangeCompletion("update", { id: 1, title: "rename" })).toBe(false);
    expect(taskMutationCanChangeCompletion("update", { id: 1, status: "done" })).toBe(true);
    expect(taskMutationCanChangeCompletion("update", { id: 1, parentId: 7 })).toBe(true);
    expect(taskMutationCanChangeCompletion("delete")).toBe(true);
    expect(taskMutationCanChangeCompletion("split")).toBe(false);
    expect(taskMutationCanChangeCompletion("subtasks")).toBe(true);
    expect(taskMutationCanChangeCompletion("reorder")).toBe(false);
  });

  it("adds shop only for completion-capable task mutations and never writes cache totals", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const setData = vi.spyOn(qc, "setQueryData");

    invalidateTaskMutationQueries(qc, false);
    expect(invalidatedKeys(invalidate)).not.toContain(JSON.stringify(["shop"]));
    invalidate.mockClear();

    invalidateTaskMutationQueries(qc, true);
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        JSON.stringify(["gamification"]),
        JSON.stringify(["shop"]),
        JSON.stringify(["challenge"]),
      ]),
    );
    expect(setData).not.toHaveBeenCalled();
  });

  it("invalidates gamification and the independent shop after a successful claim only", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    postMock.mockResolvedValueOnce({
      xpAwarded: 25,
      goldAwarded: 5,
      levelUp: false,
      newAchievements: [],
    });
    const observer = new MutationObserver(qc, claimAchievementMutation(qc));
    await observer.mutate("first_draw");
    expect(invalidatedKeys(invalidate)).toEqual([
      JSON.stringify(["gamification"]),
      JSON.stringify(["shop"]),
    ]);

    invalidate.mockClear();
    postMock.mockRejectedValueOnce(new Error("claim failed"));
    await expect(observer.mutate("first_draw")).rejects.toThrow("claim failed");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps timer challenge/gamification/shop refetches in onSettled for success and races/errors", async () => {
    for (const result of ["success", "error"] as const) {
      const qc = new QueryClient();
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      const setData = vi.spyOn(qc, "setQueryData");
      if (result === "success") postMock.mockResolvedValueOnce({});
      else postMock.mockRejectedValueOnce(new Error("timer race"));
      const observer = new MutationObserver(qc, stopTimerMutation(qc));

      if (result === "success") await observer.mutate(undefined);
      else await expect(observer.mutate(undefined)).rejects.toThrow("timer race");

      expect(invalidatedKeys(invalidate)).toEqual(
        expect.arrayContaining([
          JSON.stringify(["challenge"]),
          JSON.stringify(["gamification"]),
          JSON.stringify(["shop"]),
        ]),
      );
      expect(setData).not.toHaveBeenCalled();
    }
  });
});
