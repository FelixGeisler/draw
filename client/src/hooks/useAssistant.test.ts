import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { agentApplyMutation } from "./useAssistant";
import { api, ApiError } from "../api/client";

// The apply mutation's #143 contract, exercised through query-core's own
// MutationObserver (the useAi.test.ts precedent): a 409 "already applied"
// carrying the ORIGINAL created mapping resolves as success — the tasks exist
// from the first apply, so an honest retry reconciles instead of surfacing an
// error (or worse, inviting another click that duplicates). Only the HTTP
// layer is mocked; ApiError stays the real class so instanceof holds.
vi.mock("../api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/client")>();
  return { ...mod, api: { ...mod.api, post: vi.fn() } };
});
const postMock = vi.mocked(api.post);

const MAPPING = [
  { draftId: "draft-1", taskIds: [7] },
  { draftId: "draft-2", taskIds: [8, 9] },
];

describe("agentApplyMutation (#143)", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("passes a 201 result through and invalidates the task-derived queries", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const observer = new MutationObserver(qc, agentApplyMutation(qc));
    postMock.mockResolvedValueOnce({ created: MAPPING });

    const result = await observer.mutate({
      sessionId: "s1",
      changesetVersion: 1,
      operations: [{ kind: "create_task", draftId: "draft-1", task: { title: "t", categoryId: 1 } }],
    });

    expect(result).toEqual({ created: MAPPING });
    // The version travels — it is the key the server consumes changesets by.
    expect(postMock).toHaveBeenCalledExactlyOnceWith(
      "/api/ai/agent/apply",
      expect.objectContaining({ sessionId: "s1", changesetVersion: 1 }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks"] });
  });

  it("treats a 409 WITH the original mapping as success and flags alreadyApplied", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const observer = new MutationObserver(qc, agentApplyMutation(qc));
    postMock.mockRejectedValueOnce(
      new ApiError(409, "changeset already applied — returning the original result", {
        error: "changeset already applied — returning the original result",
        created: MAPPING,
      }),
    );

    const result = await observer.mutate({
      sessionId: "s1",
      changesetVersion: 1,
      operations: [{ kind: "create_task", draftId: "draft-1", task: { title: "t", categoryId: 1 } }],
    });

    expect(result).toEqual({ created: MAPPING, alreadyApplied: true });
    // onSuccess ran: the tasks DO exist, the lists must refresh.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks"] });
  });

  it("keeps a 409 WITHOUT a mapping an error — there is nothing to reconcile with", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const observer = new MutationObserver(qc, agentApplyMutation(qc));
    const bare = new ApiError(409, "this changeset was already applied and its result is no longer available", {
      error: "this changeset was already applied and its result is no longer available",
    });
    postMock.mockRejectedValueOnce(bare);

    await expect(
      observer.mutate({
        sessionId: "s1",
        changesetVersion: 1,
        operations: [{ kind: "create_task", draftId: "draft-1", task: { title: "t", categoryId: 1 } }],
      }),
    ).rejects.toBe(bare);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps every non-409 failure an error (a 400 plan rejection must not read as applied)", async () => {
    const qc = new QueryClient();
    const observer = new MutationObserver(qc, agentApplyMutation(qc));
    const rejection = new ApiError(400, "duplicate draftId draft-1", { error: "duplicate draftId draft-1" });
    postMock.mockRejectedValueOnce(rejection);

    await expect(
      observer.mutate({
        operations: [{ kind: "create_task", draftId: "draft-1", task: { title: "t", categoryId: 1 } }],
      }),
    ).rejects.toBe(rejection);
  });
});
