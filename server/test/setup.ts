import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type Database from "better-sqlite3";

// Runs before each test file is imported (vitest setupFiles + forked pool):
// every test file gets its own throwaway database directory, and AI runs in
// degraded mode. The user's real server/data/ is never touched by tests.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draw-test-"));
delete process.env.ANTHROPIC_API_KEY;

// Install the test-only constructor before src/db.ts is imported. Production
// source has no fixture branch or global bridge; the safe adapter and its
// closure-private handle tracking live entirely under test/.
const [{ default: NativeDatabase }, { trackFixtureDatabase }] = await Promise.all([
  vi.importActual("better-sqlite3") as Promise<{ default: typeof Database }>,
  import("./databaseFixture.js"),
]);
const FixtureTrackingDatabase = new Proxy(NativeDatabase, {
  construct(target, args) {
    const database = Reflect.construct(target, args, target) as Database.Database;
    trackFixtureDatabase(database);
    return database;
  },
});
vi.doMock("better-sqlite3", () => ({ default: FixtureTrackingDatabase }));
