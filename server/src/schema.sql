CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  outcome TEXT,
  target_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'achieved', 'dropped')) DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  impact INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 5) DEFAULT 3,
  effort_minutes INTEGER,
  due_date TEXT,
  recur_every_days INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'archived')) DEFAULT 'open',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_drawn_at TEXT,
  -- Snooze/block (ADR-17): deferred_until is retained after expiry as the wake
  -- timestamp for staleness; drawability stays a derived predicate (ADR-2).
  deferred_until TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  -- Sequential subtask mode (#23, ADR-18): only meaningful on parents. A
  -- 'sequential' parent exposes only its first open subtask in creation order
  -- to the draw pool; "held back" stays a derived predicate (ADR-2).
  subtask_order_mode TEXT NOT NULL CHECK (subtask_order_mode IN ('parallel', 'sequential')) DEFAULT 'parallel',
  -- Availability window (#33, ADR-20): weekdays (JSON array of 0–6, JS getDay
  -- convention) plus a daily [start, end) range as "HH:MM" ("24:00" allowed as
  -- end). All three set or all three NULL. Evaluated on the LOCAL wall clock
  -- in TypeScript — never in SQL, where strftime/time run in UTC.
  window_days TEXT,
  window_start TEXT,
  window_end TEXT
);

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX idx_time_entries_task ON time_entries(task_id);

CREATE TABLE completions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  was_drawn INTEGER NOT NULL DEFAULT 0,
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  -- Warm-up draw (#57, ADR-30): 1 when the task was completed as the dealt
  -- warm-up card. Momentum (×1.25 on the NEXT completion within 30 minutes)
  -- is derived from these rows at completion time, never stored — undoing the
  -- warm-up completion disarms it automatically (ADR-2/ADR-5).
  was_warmup INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_completions_date ON completions(completed_at);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  filename TEXT,
  stored_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  note_text TEXT,
  created_at TEXT NOT NULL
);

-- AI card art cache (#27, ADR-22): one sanitized SVG per task, generated at
-- most once. svg holds the SANITIZED markup (svgSanitizer.ts runs before any
-- INSERT); deleting a task takes its art with it.
CREATE TABLE card_art (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  svg TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE achievements (
  key TEXT PRIMARY KEY,
  unlocked_at TEXT NOT NULL
);

-- Streak freeze tokens (#58, ADR-28): append-only log of EARNED events only.
-- milestone_day is the local day the streak crossed a 7-real-day multiple;
-- its UNIQUE constraint makes earning idempotent per milestone (undo/redo
-- cannot farm). Consumption is never stored — it is derived on every read by
-- the walk-back fold in streak.ts, keeping GET side-effect free (ADR-5: log
-- over counters). The streak itself stays fully derived (ADR-2).
CREATE TABLE streak_freezes (
  id INTEGER PRIMARY KEY,
  milestone_day TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO categories (name, color, is_default) VALUES
  ('Work', '#4f8cff', 1),
  ('Study', '#a06bff', 1),
  ('Household', '#3fbf7f', 1);

INSERT INTO settings (key, value) VALUES
  ('max_draw_effort', '30'),
  ('draw_cooldown_minutes', '60'),
  ('daily_goal_completions', '1'),
  ('warmup_every_hours', '8'),
  ('daily_hand_budget_minutes', '90');
