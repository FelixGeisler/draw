/** Remove schema-v24 session outcome additions from today's fresh schema. */
export function stripV24Schema(sql: string): string {
  return sql
    .replace(
      /,\r?\n  end_reason TEXT CHECK \(\r?\n    \(ended_at IS NULL AND end_reason IS NULL\) OR\r?\n    \(ended_at IS NOT NULL AND \(end_reason IS NULL OR end_reason IN \('done', 'stop'\)\)\)\r?\n  \)/,
      "",
    )
    .replace(
      /CREATE INDEX idx_time_entries_forest ON time_entries\(id DESC\) WHERE end_reason IS NOT NULL;\r?\n/,
      "",
    );
}

/** Remove schema-v23 projection DDL from today's fresh schema. */
export function stripV23Schema(sql: string): string {
  return stripV24Schema(sql).replace(
    /-- Compact Week interval-access foundation \(#363, ADR-75\)\.[\s\S]*$/,
    "",
  );
}

/**
 * Remove schema-v22 and newer additions from today's schema.sql when a
 * migration test reconstructs an older stamped database.
 */
export function stripV22Schema(sql: string): string {
  return stripV23Schema(sql)
    .replace(/CREATE INDEX idx_goals_target_date ON goals\(target_date, id\);\r?\n\r?\n/, "")
    .replace(/CREATE INDEX idx_tasks_due_date ON tasks\(due_date, id\);\r?\n/, "")
    .replace(
      /-- Fixed task appointments \(#357, ADR-74\):[\s\S]*?CREATE INDEX idx_task_fixed_slots_range\r?\n  ON task_fixed_slots\(starts_at, ends_at, task_id\);\r?\n\r?\n/,
      "",
    )
    .replace(/CREATE INDEX idx_time_entries_range ON time_entries\(started_at, ended_at, id\);\r?\n/, "");
}
