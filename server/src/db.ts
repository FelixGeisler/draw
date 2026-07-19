import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR override lets tests (and E2E runs) use an isolated database.
export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(here, "../data");
export const filesDir = path.join(dataDir, "files");
export const dbPath = path.join(dataDir, "app.db");

fs.mkdirSync(filesDir, { recursive: true });

function openDatabase(): Database.Database {
  const handle = new Database(dbPath);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  return handle;
}

// `let`, not `const`: backup import (#61, ADR-26) swaps the database file on
// disk and reopens the handle. ESM live bindings mean every module that
// imports { db } sees the new handle on its next access — no code in this
// repo caches prepared statements or transactions across requests, so a
// reopen is safe between requests (better-sqlite3 is synchronous, and the
// whole swap runs in one synchronous block: no request can interleave).
export let db = openDatabase();

export const CURRENT_VERSION = 14;

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
      // the ancestor graph is acyclic: every pre-v7 database was written by
      // code that only ever set parent_id at INSERT referencing an existing
      // row. (Since #100 parent_id is also rewritten by the reparent PATCH —
      // which postdates this migration — but the guarantee carries over: a
      // reparent target must be a root and the moved task must be childless,
      // so the moved node never becomes anyone's ancestor and no cycle can
      // be minted, ADR-24.) Each pass strictly
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
        // left as-is, even where the adopted goal_id is NULL: this repair
        // moves rows the user never asked to move, so unlike a DELIBERATE
        // goal wipe — a parent unlink (#76) or a #100 reparent into a
        // goal-less root, both of which reset impact to the neutral 3 — the
        // historical rating is grandfathered the way goal deletion
        // grandfathers one, and the ADR-4 no-op tolerance keeps such rows
        // editable. Not an oversight (ADR-24).
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
      // Streak freeze tokens (issue #58, ADR-28): append-only earn log;
      // consumption stays derived at read time.
      db.exec(`CREATE TABLE streak_freezes (
        id INTEGER PRIMARY KEY,
        milestone_day TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`);
    }
    if (version < 9) {
      // Warm-up draw (issue #57, ADR-30): completions record whether the task
      // was completed as the dealt warm-up card (momentum derives from these
      // rows), and the rate limit becomes a user setting. INSERT OR IGNORE:
      // a restored backup may already carry the row.
      db.exec("ALTER TABLE completions ADD COLUMN was_warmup INTEGER NOT NULL DEFAULT 0");
      db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('warmup_every_hours', '8')");
    }
    if (version < 10) {
      // Daily hand (issue #59, ADR-34): a PURE DATA migration — the hand
      // itself needs no table (it is one settings row of JSON, ADR-13's
      // pattern), so the version bump exists solely to seed the new public
      // setting on existing databases. Without it `daily_hand_budget_minutes`
      // would be absent from GET /api/settings until the first PATCH wrote
      // it, and the Draw page's budget input would render empty on exactly
      // the databases that predate the feature. INSERT OR IGNORE: a restored
      // backup may already carry the row.
      db.exec(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_hand_budget_minutes', '90')",
      );
    }
    if (version < 11) {
      // Anthropic Files API for goal materials (issue #92, ADR-35): PDFs are
      // uploaded once and referenced by file id instead of re-sending base64
      // on every AI call. Nullable with no default and no backfill BECAUSE
      // the column is a CACHE of Anthropic-side state, not data we own: NULL
      // simply means "not uploaded under the current key yet", which is the
      // truth for every pre-#92 row, and the first AI use fills it in. There
      // is deliberately nothing to migrate — the PDFs under files/ remain the
      // source of truth, so a database that never gets an id keeps working on
      // the base64 fallback path.
      db.exec("ALTER TABLE materials ADD COLUMN anthropic_file_id TEXT");
    }
    if (version < 12) {
      // Goal resolution (#145, ADR-38): 'missed' joins the status CHECK and
      // resolved_at records when the goal left 'active' — an event fact, not
      // derivable state (ADR-2 bans stored DERIVABLES; there is no transition
      // log to derive this from). No backfill: pre-v12 achieved/dropped rows
      // keep NULL = "resolution date unknown", the same honesty as v11's
      // anthropic_file_id.
      //
      // SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
      // foreign_keys MUST be OFF for the rebuild: with it ON, the implicit
      // row deletion of DROP TABLE fires the FK actions on this table's
      // referencers — tasks.goal_id ON DELETE SET NULL would silently unlink
      // every task and materials.goal_id ON DELETE CASCADE would delete every
      // material. The pragma is a no-op inside a transaction, so it toggles
      // outside; foreign_key_check afterwards proves the rebuilt table left
      // no dangling reference — scoped to the two tables that reference
      // goals, so a pre-existing violation in an unrelated table cannot
      // abort the boot blaming this rebuild. No indexes/triggers/views
      // exist on goals — nothing else to recreate.
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(`CREATE TABLE goals_new (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            outcome TEXT,
            target_date TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'achieved', 'missed', 'dropped')) DEFAULT 'active',
            created_at TEXT NOT NULL,
            resolved_at TEXT
          )`);
          // id copied explicitly — it is the FK target of tasks and materials.
          db.exec(`INSERT INTO goals_new (id, title, outcome, target_date, status, created_at)
                   SELECT id, title, outcome, target_date, status, created_at FROM goals`);
          db.exec("DROP TABLE goals");
          db.exec("ALTER TABLE goals_new RENAME TO goals");
          const violations = [
            ...(db.pragma("foreign_key_check(tasks)") as unknown[]),
            ...(db.pragma("foreign_key_check(materials)") as unknown[]),
          ];
          if (violations.length > 0) {
            throw new Error(
              "v12 migration: foreign_key_check failed after the goals rebuild (issue #145, ADR-38)",
            );
          }
        })();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
    if (version < 13) {
      // Daily hand removal (#147, ADR-39): the feature was PURE DATA (v10
      // seeded a settings row, the hand itself lived in another — no table,
      // ADR-34), so its removal is pure data too: delete the now-orphaned
      // rows. Leaving them would be harmless today but would hand a future
      // key collision a stale '90' — and a database should not carry rows no
      // code can read. v10 above stays verbatim: on a pre-v10 file it still
      // seeds the row this step deletes, which is the honest replay of
      // history (the chain test pins exactly that).
      db.exec("DELETE FROM settings WHERE key IN ('daily_hand_budget_minutes', 'daily_hand')");
    }
    if (version < 14) {
      // Achievement chains + claim-for-XP (#156, ADR-42). Two additions:
      //
      //   1. The draws log — a new append-only event table (ADR-5's log-over-
      //      counters, the shape of completions and streak_freezes). A draw
      //      HAPPENED even if the task is later deleted, so task_id is
      //      ON DELETE SET NULL, never CASCADE. No backfill: pre-log draws are
      //      honestly unknown, so the draws-chain progress bar simply starts
      //      at 0 on an existing database.
      //
      //   2. Two nullable columns on achievements for the claim: claimed_at
      //      (the event fact) and claim_xp (the stamped amount). No default,
      //      no backfill — every pre-#156 row reads as "unlocked, unclaimed",
      //      which is exactly the launch-payday state (the 11 existing unlocks
      //      become immediately claimable).
      db.exec(`CREATE TABLE draws (
        id INTEGER PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        drawn_at TEXT NOT NULL,
        was_warmup INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec("ALTER TABLE achievements ADD COLUMN claimed_at TEXT");
      db.exec("ALTER TABLE achievements ADD COLUMN claim_xp INTEGER");
    }
  }
  db.pragma(`user_version = ${CURRENT_VERSION}`);
}

migrate();

/**
 * Close the current handle (if still open) and reopen the database file at
 * dbPath, running migrations forward. Used by backup import (#61, ADR-26)
 * after it has swapped a restored snapshot into place — the snapshot may come
 * from an older schema version, so migrate() must run exactly like on boot.
 */
export function reopenDatabase() {
  if (db.open) db.close();
  db = openDatabase();
  migrate();
}

// Settings key for the Claude API key. Stored plaintext in the local
// single-user SQLite DB (ADR-11) and excluded from every API response.
export const API_KEY_SETTING = "anthropic_api_key";

// Settings key holding the id of the currently drawn task (ADR-13). Internal
// session state — single-user app, one current draw — not a user setting, so
// the generic settings endpoints exclude it.
export const CURRENT_DRAW_SETTING = "current_draw_task_id";

// Warm-up draw (#57, ADR-30) — internal session state next to the current
// draw, excluded from the settings endpoints exactly like it.
// WARMUP_DRAW_SETTING marks the current draw as a warm-up deal (JSON:
// {taskId, dealtAt, windowMinutes}); it is cleared everywhere the current
// draw is cleared, so it can never point at a card that is no longer the
// current draw. WARMUP_LAST_DEALT_SETTING records the last deal (JSON:
// {taskId, dealtAt}) and is never cleared: dealing consumes the one-per-
// `warmup_every_hours` allowance irrevocably — discarding the card does not
// refund it, so the warm-up cannot be fished for a better card.
export const WARMUP_DRAW_SETTING = "warmup_current_draw";
export const WARMUP_LAST_DEALT_SETTING = "warmup_last_dealt";

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
