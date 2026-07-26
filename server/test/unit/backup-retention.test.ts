import { describe, expect, it } from "vitest";
import {
  backupsToPrune,
  isScheduledBackupName,
  scheduledBackupStem,
} from "../../src/services/backupService.js";

// Scheduled-backup naming + retention selection (#194, ADR-52). Pure functions:
// no fs, no clock, no timers — deterministic against synthetic inputs.

describe("scheduledBackupStem", () => {
  it("is ISO-8601 to the second with `:` swapped for `-` (a legal filename everywhere)", () => {
    const stem = scheduledBackupStem(new Date("2026-07-26T14:30:05.123Z"));
    expect(stem).toBe("draw-backup-2026-07-26T14-30-05Z");
    // No colon survives — colons are illegal in Windows filenames.
    expect(stem).not.toContain(":");
  });

  it("produces names that sort lexically == chronologically", () => {
    const earlier = `${scheduledBackupStem(new Date("2026-07-26T08:00:00Z"))}.zip`;
    const later = `${scheduledBackupStem(new Date("2026-07-26T09:00:00Z"))}.zip`;
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("isScheduledBackupName", () => {
  it("matches names scheduledBackupStem produces, with or without a `-N` de-dupe suffix", () => {
    expect(isScheduledBackupName("draw-backup-2026-07-26T14-30-05Z.zip")).toBe(true);
    expect(isScheduledBackupName("draw-backup-2026-07-26T14-30-05Z-1.zip")).toBe(true);
  });

  it("rejects the manual export name (date only) and any foreign file", () => {
    // Manual GET /api/backup/export names are date-only and never land in
    // backups/, but retention must not claim them even if one did.
    expect(isScheduledBackupName("draw-backup-2026-07-26.zip")).toBe(false);
    expect(isScheduledBackupName("notes.txt")).toBe(false);
    expect(isScheduledBackupName("draw-backup-2026-07-26T14-30-05Z.zip.tmp")).toBe(false);
    expect(isScheduledBackupName("app.db")).toBe(false);
  });
});

describe("backupsToPrune", () => {
  const names = [
    "draw-backup-2026-07-20T00-00-00Z.zip",
    "draw-backup-2026-07-21T00-00-00Z.zip",
    "draw-backup-2026-07-22T00-00-00Z.zip",
    "draw-backup-2026-07-23T00-00-00Z.zip",
  ];

  it("keeps the newest N and returns the older ones (oldest first)", () => {
    expect(backupsToPrune(names, 2)).toEqual([
      "draw-backup-2026-07-20T00-00-00Z.zip",
      "draw-backup-2026-07-21T00-00-00Z.zip",
    ]);
    expect(backupsToPrune(names, 1)).toEqual([
      "draw-backup-2026-07-20T00-00-00Z.zip",
      "draw-backup-2026-07-21T00-00-00Z.zip",
      "draw-backup-2026-07-22T00-00-00Z.zip",
    ]);
  });

  it("prunes nothing when retention >= the number of archives", () => {
    expect(backupsToPrune(names, 4)).toEqual([]);
    expect(backupsToPrune(names, 99)).toEqual([]);
    expect(backupsToPrune([], 3)).toEqual([]);
  });

  it("ignores foreign files — only scheduled archives are ever pruned", () => {
    const mixed = [
      "app.db.bak",
      "draw-backup-2026-07-20T00-00-00Z.zip",
      "keep-me.zip",
      "draw-backup-2026-07-21T00-00-00Z.zip",
    ];
    expect(backupsToPrune(mixed, 1)).toEqual(["draw-backup-2026-07-20T00-00-00Z.zip"]);
  });

  it("orders by name regardless of directory-listing order (lexical == chronological)", () => {
    const shuffled = [names[2], names[0], names[3], names[1]];
    expect(backupsToPrune(shuffled, 2)).toEqual([
      "draw-backup-2026-07-20T00-00-00Z.zip",
      "draw-backup-2026-07-21T00-00-00Z.zip",
    ]);
  });
});
