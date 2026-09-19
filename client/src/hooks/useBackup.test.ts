import { describe, expect, it } from "vitest";
import {
  backupRestoreMessage,
  PUSH_RECOVERY_PENDING_MESSAGE,
} from "./useBackup";

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
