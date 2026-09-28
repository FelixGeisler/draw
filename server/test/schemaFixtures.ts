/**
 * Remove schema-v22 additions from today's schema.sql when a migration test
 * reconstructs an older stamped database. Keeping this one exact helper
 * prevents every historical fixture from accidentally carrying future DDL.
 */
export function stripV22Schema(sql: string): string {
  return sql
    .replace(/CREATE INDEX idx_goals_target_date ON goals\(target_date, id\);\r?\n\r?\n/, "")
    .replace(/CREATE INDEX idx_tasks_due_date ON tasks\(due_date, id\);\r?\n/, "")
    .replace(
      /-- Fixed task appointments \(#357, ADR-74\):[\s\S]*?CREATE INDEX idx_task_fixed_slots_range\r?\n  ON task_fixed_slots\(starts_at, ends_at, task_id\);\r?\n\r?\n/,
      "",
    )
    .replace(/CREATE INDEX idx_time_entries_range ON time_entries\(started_at, ended_at, id\);\r?\n/, "");
}
