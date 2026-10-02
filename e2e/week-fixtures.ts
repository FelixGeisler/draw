import type { SafeDatabase } from "../server/src/safeDatabase.js";

interface WeekSeedCapabilities {
  db: SafeDatabase;
  maintainFixedIntervalWrite(taskId: number, write: () => void): void;
  beginWeekIntervalMutation(): unknown;
  reprojectTrackedIntervals(token: unknown, entryIds: readonly number[]): void;
  finalizeWeekIntervalMutation(token: unknown): void;
}

/**
 * Direct test-only historical fixture adapter. It is imported only by the
 * Playwright spec, remains outside the production graph, and writes a fresh
 * one-worker Temp database before its server starts accepting requests.
 */
export function seedHistoricalWeek(capabilities: WeekSeedCapabilities) {
  const { db } = capabilities;
  const insertTask = db.prepare(
    `INSERT INTO tasks (id,title,category_id,due_date,status,created_at)
     VALUES (?,?,?,?,?,?)`,
  );
  const created = "2026-01-01T00:00:00.000Z";
  const rows: Array<[number, string, string | null, "open" | "done" | "archived"]> = [
    [101, "Crossing fixed", null, "open"],
    [102, "Equal fixed alpha", null, "open"],
    [103, "Equal fixed beta", null, "done"],
    [104, "Dual deadline", "2026-10-28", "open"],
    [105, "Tracked source", null, "open"],
    [106, "Archived source", null, "archived"],
    [107, "Overnight source", null, "open"],
    [108, "<script>hostile()</script>", "2026-10-31", "open"],
    [109, "x".repeat(140_000), "2026-11-01", "open"],
  ];
  for (const [id, title, dueDate, status] of rows) insertTask.run(id, title, 1, dueDate, status, created);
  db.prepare("INSERT INTO goals (id,title,target_date,status,created_at) VALUES (?,?,?,?,?)")
    .run(201, "Historical goal", "2026-10-30", "active", created);

  const fixed = db.prepare("INSERT INTO task_fixed_slots (task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)");
  for (const [taskId, start, end] of [
    [101, "2026-10-25T22:00:00.000Z", "2026-10-26T01:00:00.000Z"],
    [102, "2026-10-27T09:00:00.000Z", "2026-10-27T11:00:00.000Z"],
    [103, "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z"],
    [104, "2026-10-28T13:00:00.000Z", "2026-10-28T14:00:00.000Z"],
  ] as const) {
    capabilities.maintainFixedIntervalWrite(taskId, () => fixed.run(taskId, start, end, "UTC"));
  }

  const insertEntry = db.prepare("INSERT INTO time_entries (id,task_id,started_at,ended_at) VALUES (?,?,?,?)");
  const entryIds: number[] = [];
  const token = capabilities.beginWeekIntervalMutation();
  for (const [id, taskId, start, end] of [
    [301, 105, "2026-10-27T09:30:00.000Z", "2026-10-27T10:30:00.000Z"],
    [302, 105, "2026-10-27T11:00:00.000Z", "2026-10-27T12:00:00.000Z"],
    [303, 106, "2026-10-29T08:00:00.000Z", "2026-10-29T09:00:00.000Z"],
    [304, 107, "2026-10-30T23:30:00.000Z", "2026-10-31T01:30:00.000Z"],
  ] as const) {
    insertEntry.run(id, taskId, start, end);
    entryIds.push(id);
  }
  capabilities.reprojectTrackedIntervals(token, entryIds);
  capabilities.finalizeWeekIntervalMutation(token);
}
