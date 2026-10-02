import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { FOREST_QUERY_KEY, type ForestState } from "../lib/forest";
import {
  backupRestoreMessage,
  importBackupMutation,
  PUSH_RECOVERY_PENDING_MESSAGE,
} from "./useBackup";

afterEach(() => vi.unstubAllGlobals());

function priorForest(): ForestState {
  return {
    kind: "published",
    requestedBeforeId: 50,
    current: null,
    page: { trees: [], nextBeforeId: null },
  };
}

describe("backup restore result copy", () => {
  it("keeps the normal count summary", () => {
    expect(backupRestoreMessage({ tasks: 2, goals: 1, materials: 3 })).toBe(
      "Backup restored — 2 tasks, 1 goals, 3 materials.",
    );
  });

  it("uses the exact committed-but-recovery-pending warning", () => {
    expect(
      backupRestoreMessage({ tasks: 2, goals: 1, materials: 3, pushRecoveryPending: true }),
    ).toBe(PUSH_RECOVERY_PENDING_MESSAGE);
    expect(PUSH_RECOVERY_PENDING_MESSAGE).toBe(
      "Backup restored; notifications remain unavailable until Draw restarts and completes Push recovery. Do not retry the restore.",
    );
  });
});

describe("backup replacement forest recovery", () => {
  it("clears the pre-restore snapshot after a successful atomic replacement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tasks: 1, goals: 2, materials: 3 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const qc = new QueryClient();
    qc.setQueryData(FOREST_QUERY_KEY, priorForest());
    const observer = new MutationObserver(qc, importBackupMutation(qc));
    await observer.mutate(new File(["archive"], "draw.zip"));
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual({ kind: "cleared" });
  });

  it("clears on ambiguous transport/5xx results but preserves a validated pre-write 4xx", async () => {
    for (const failure of [
      () => Promise.reject(new TypeError("response lost")),
      () => Promise.resolve(new Response(JSON.stringify({ error: "post-request failure" }), { status: 500 })),
    ]) {
      vi.stubGlobal("fetch", vi.fn(failure));
      const qc = new QueryClient();
      qc.setQueryData(FOREST_QUERY_KEY, priorForest());
      const observer = new MutationObserver(qc, importBackupMutation(qc));
      await expect(observer.mutate(new File(["archive"], "draw.zip"))).rejects.toThrow();
      expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual({ kind: "cleared" });
    }

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid backup" }), { status: 400 })));
    const qc = new QueryClient();
    const previous = priorForest();
    qc.setQueryData(FOREST_QUERY_KEY, previous);
    const observer = new MutationObserver(qc, importBackupMutation(qc));
    await expect(observer.mutate(new File(["archive"], "draw.zip"))).rejects.toThrow("invalid backup");
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
  });
});
