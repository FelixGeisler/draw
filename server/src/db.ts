import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../data");
export const filesDir = path.join(dataDir, "files");

fs.mkdirSync(filesDir, { recursive: true });

export const db = new Database(path.join(dataDir, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const CURRENT_VERSION = 2;

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
  }
  db.pragma(`user_version = ${CURRENT_VERSION}`);
}

migrate();

export function getSetting(key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
