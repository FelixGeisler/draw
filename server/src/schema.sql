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
  -- Goal resolution (#145, ADR-38): 'missed' = the outcome is decided and the
  -- goal was not reached — a user assertion, never set automatically (the app
  -- cannot know a grade); 'dropped' = abandoned by choice. resolved_at is an
  -- EVENT FACT (the moment the goal left 'active'), not derivable state, so
  -- storing it stays within ADR-2: set once on leaving 'active', kept across
  -- resends and achieved<->missed corrections, cleared on reactivation. NULL
  -- on rows resolved before v12 = unknown.
  status TEXT NOT NULL CHECK (status IN ('active', 'achieved', 'missed', 'dropped')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  resolved_at TEXT
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
  -- Anthropic Files API id for this material's PDF (#92, ADR-35). A CACHE of
  -- remote state, never identity: the file lives in the Anthropic account
  -- behind the current API key, so a restored backup, a key swap or a
  -- server-side expiry can leave this dangling. Every reader must tolerate a
  -- stale value (aiService clears it and re-uploads on rejection); the file
  -- under files/ stays the source of truth. NULL = not uploaded yet — the id
  -- is filled lazily on first AI use, never at material upload time.
  anthropic_file_id TEXT,
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
  unlocked_at TEXT NOT NULL,
  -- Claim-for-XP (#156, ADR-42): an unlocked achievement can be CLAIMED once
  -- ever for rarity-scaled XP — a SECOND stored XP source amending ADR-5's
  -- "XP is the completions log" (totalXp now sums both). claimed_at is the
  -- event fact; claim_xp is the amount, stamped from the SERVER tier table at
  -- claim time (the client is never the XP authority). Both NULL until claimed;
  -- idempotent by the primary key — one row per key, one claim ever.
  claimed_at TEXT,
  claim_xp INTEGER
);

-- Draw log (#156, ADR-42): append-only event log of every card dealt, the
-- ADR-5 shape (log over counters) like completions and streak_freezes. A draw
-- HAPPENED even if the task is later deleted, so task_id is ON DELETE SET NULL,
-- NEVER CASCADE — losing the task must not rewrite draw history. was_warmup
-- separates gambled draws from handed-out warm-up deals (ADR-30); the draws
-- achievement chain counts non-warmup rows only.
CREATE TABLE draws (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  drawn_at TEXT NOT NULL,
  was_warmup INTEGER NOT NULL DEFAULT 0
);

-- Streak freeze tokens (#58, ADR-28): append-only log of EARNED events only.
-- milestone_day is the local day the streak crossed a 7-real-day multiple;
-- its UNIQUE constraint makes earning idempotent per milestone (undo/redo
-- cannot farm). Consumption is never stored — it is derived on every read by
-- the forward replay in streak.ts, keeping GET side-effect free (ADR-5: log
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
  ('warmup_every_hours', '8');
