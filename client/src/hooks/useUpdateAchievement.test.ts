import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { updateAchievementMutation } from "./useGamification";
import { api } from "../api/client";

// The display-customization mutation (#177, ADR-44), exercised through
// query-core's own MutationObserver (the agentApplyMutation precedent — the
// client suite has no DOM). Only the HTTP layer is mocked: the PATCH must carry
// the override body under /api/achievements/:key, and a success must invalidate
// ['gamification'] so the collection, header and any open toast re-read the
// COALESCE'd title/description.
vi.mock("../api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/client")>();
  return { ...mod, api: { ...mod.api, patch: vi.fn() } };
});
const patchMock = vi.mocked(api.patch);

describe("updateAchievementMutation (#177)", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("PATCHes the override body (key in the URL, not the body) and invalidates ['gamification']", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const observer = new MutationObserver(qc, updateAchievementMutation(qc));
    patchMock.mockResolvedValueOnce({ key: "draw_10", title: "My tens", hidden: true });

    const result = await observer.mutate({ key: "draw_10", title: "My tens", hidden: true });

    expect(result).toMatchObject({ key: "draw_10", title: "My tens" });
    // The key is the URL segment; only the override fields go in the body.
    expect(patchMock).toHaveBeenCalledExactlyOnceWith("/api/achievements/draw_10", {
      title: "My tens",
      hidden: true,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gamification"] });
  });

  it("carries a null override through to clear it (reset to default)", async () => {
    const qc = new QueryClient();
    const observer = new MutationObserver(qc, updateAchievementMutation(qc));
    patchMock.mockResolvedValueOnce({ key: "draw_10", customized: false });

    await observer.mutate({ key: "draw_10", title: null, description: null, hidden: false });

    expect(patchMock).toHaveBeenCalledExactlyOnceWith("/api/achievements/draw_10", {
      title: null,
      description: null,
      hidden: false,
    });
  });

  it("does not invalidate when the PATCH fails", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const observer = new MutationObserver(qc, updateAchievementMutation(qc));
    patchMock.mockRejectedValueOnce(new Error("boom"));

    await expect(observer.mutate({ key: "draw_10", hidden: true })).rejects.toThrow("boom");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
