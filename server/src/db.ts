import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR override lets tests (and E2E runs) use an isolated database.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(here, "../data");
export const filesDir = path.join(dataDir, "files");

fs.mkdirSync(filesDir, { recursive: true });

export const db = new Database(path.join(dataDir, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const CURRENT_VERSION = 8;

function migrate() {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    // Fresh database — schema.sql is always the CURRENT schema.
    const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf-8");
    db.exec(schema);
  } else {
    if (version < 2) {
      db.exec("ALTER TABLE materials ADD COLUMN stored_name TEXT");
    }
    if (version < 3) {
      // Snooze/block (issue #19, ADR-17).
      db.exec("ALTER TABLE tasks ADD COLUMN deferred_until TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
    }
    if (version < 4) {
      // Sequential subtask mode (issue #23, ADR-18).
      db.exec(
        "ALTER TABLE tasks ADD COLUMN subtask_order_mode TEXT NOT NULL CHECK (subtask_order_mode IN ('parallel', 'sequential')) DEFAULT 'parallel'",
      );
    }
    if (version < 5) {
      // Availability window (issue #33, ADR-20): all three set or all NULL.
      db.exec("ALTER TABLE tasks ADD COLUMN window_days TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN window_start TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN window_end TEXT");
    }
    if (version < 6) {
      // AI card art cache (issue #27, ADR-22): sanitized SVG, once per task.
      db.exec(`CREATE TABLE card_art (
        task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        svg TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
    }
    if (version < 7) {
      // Legacy nested breakdowns (issue #80, ADR-16/ADR-24): before the #35
      // guard, API/MCP calls could nest subtasks arbitrarily deep. Such rows
      // are draw-eligible yet invisible in every list, corrupt the one-level
      // rollup, leak past the sequential hold-back queue, and 409-deadlock
      // their parent — so they are repaired, not grandfathered: every task
      // whose parent is itself a subtask is re-parented one level up per
      // pass until the tree is two levels everywhere (the same flattening
      // the guard's 400 message prescribes). Each pass reads a snapshot of
      // (id, grandparent) pairs first, so a pass moves every nested row
      // exactly one step up its original chain — the loop terminates because
      // parent_id is only ever written at INSERT referencing an existing
      // row, making the ancestor graph acyclic, and each pass strictly
      // shrinks the maximum depth. Defensively the pass count is bounded
      // anyway (a chain of depth d holds d-2 nested rows, so acyclic data
      // needs at most one pass per initially nested row): a parent_id cycle
      // — impossible via the API, but this migration exists precisely for
      // rows no current code path writes — aborts the boot with a
      // diagnosable error instead of hanging it forever. Transactional: a
      // crash between hoist and cascade must not leave rows the re-run can
      // no longer tell apart.
      //
      // Hoisting can PLACE a recurring row directly under a 'sequential'
      // root — the combination the #66 guard rejects on every write path
      // (ADR-23). Deliberate, recorded in ADR-24: the row is tolerated-but-
      // repairable exactly like a pre-ban row (no-op resends pass; the user
      // drops the recurrence or flips the root to parallel, and the
      // transition guards prevent re-creating it). The guard must NOT run
      // here — it would fail the migration on the very legacy data it
      // exists to repair. Pinned by migration-v6-recurring.test.ts.
      db.transaction(() => {
        const findNested = db.prepare(
          `SELECT t.id AS id, p.parent_id AS grandparentId
           FROM tasks t JOIN tasks p ON p.id = t.parent_id
           WHERE p.parent_id IS NOT NULL`,
        );
        const hoist = db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?");
        const reparented = new Set<number>();
        const maxPasses = (findNested.all() as unknown[]).length + 1;
        for (let pass = 0; ; pass++) {
          const nested = findNested.all() as { id: number; grandparentId: number }[];
          if (nested.length === 0) break;
          if (pass >= maxPasses) {
            throw new Error(
              "v7 migration: tasks.parent_id contains a cycle — repair the database by hand (issue #80, ADR-24)",
            );
          }
          for (const { id, grandparentId } of nested) {
            hoist.run(grandparentId, id);
            reparented.add(id);
          }
        }
        // Re-parented rows join their new parent's breakdown under the same
        // cascade rules a parent edit applies (routes/tasks.ts): goal_id
        // follows the parent unconditionally, category_id only while open —
        // done/archived rows are historical records and keep the category
        // they were actually finished under (#44). impact is deliberately
        // left as-is, even where the adopted goal_id is NULL: a parent goal
        // unlink cascades NULL without resetting children's impact either,
        // and the ADR-4 no-op tolerance keeps such rows editable —
        // grandfathered, not an oversight.
        const adopt = db.prepare(
          `UPDATE tasks
           SET goal_id = (SELECT r.goal_id FROM tasks r WHERE r.id = tasks.parent_id),
               category_id = CASE
                 WHEN status = 'open'
                   THEN (SELECT r.category_id FROM tasks r WHERE r.id = tasks.parent_id)
                 ELSE category_id
               END
           WHERE id = ?`,
        );
        for (const id of reparented) adopt.run(id);
      })();
    }
    if (version < 8) {
      // Streak freeze tokens (issue #58, ADR-26): append-only earn log;
      // consumption stays derived at read time.
      db.exec(`CREATE TABLE streak_freezes (
        id INTEGER PRIMARY KEY,
        milestone_day TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`);
    }
  }
  db.pragma(`user_version = ${CURRENT_VERSION}`);
}

migrate();

// Settings key for the Claude API key. Stored plaintext in the local
// single-user SQLite DB (ADR-11) and excluded from every API response.
export const API_KEY_SETTING = "anthropic_api_key";

// Settings key holding the id of the currently drawn task (ADR-13). Internal
// session state — single-user app, one current draw — not a user setting, so
// the generic settings endpoints exclude it.
export const CURRENT_DRAW_SETTING = "current_draw_task_id";

export function getSetting(key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getSettingString(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
