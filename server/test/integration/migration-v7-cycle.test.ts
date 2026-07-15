import { beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// v7 hoist on a corrupt parent_id cycle (#80, ADR-24): no code path the app
// ever shipped can write one (parent_id is INSERT-only at the API layer),
// but this migration exists precisely for rows no current code path writes.
// The fixpoint loop bounds its pass count by the initial nested-row count,
// so a cycle aborts the boot with a diagnosable error instead of hanging
// the server forever. Own file: the poisoned db.ts import must not share a
// process with tests that need a working app.

beforeAll(() => {
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(fs.readFileSync(schemaPath, "utf-8"));

  // Two-row cycle: insert both (FK targets exist), then point A back at B.
  const insert = legacy.prepare(
    "INSERT INTO tasks (title, category_id, parent_id, created_at) VALUES (?, 1, ?, ?)",
  );
  const a = Number(insert.run("Cycle A", null, "2025-06-01T00:00:00.000Z").lastInsertRowid);
  const b = Number(insert.run("Cycle B", a, "2025-06-01T00:01:00.000Z").lastInsertRowid);
  legacy.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(b, a);

  legacy.pragma("user_version = 6");
  legacy.close();
});

it("the v7 migration aborts on a parent_id cycle with a diagnosable error instead of hanging", async () => {
  await expect(import("../../src/db.js")).rejects.toThrow(
    /v7 migration: tasks\.parent_id contains a cycle/,
  );
});
