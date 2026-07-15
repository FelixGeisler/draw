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

const CURRENT_VERSION = 5;

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
