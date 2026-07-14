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
  -- Snooze/block (ADR-14): deferred_until is retained after expiry as the wake
  -- timestamp for staleness; drawability stays a derived predicate (ADR-2).
  deferred_until TEXT,
  blocked INTEGER NOT NULL DEFAULT 0
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
  xp_awarded INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE achievements (
  key TEXT PRIMARY KEY,
  unlocked_at TEXT NOT NULL
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
  ('daily_goal_completions', '1');
