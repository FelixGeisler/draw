import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runs before each test file is imported (vitest setupFiles + forked pool):
// every test file gets its own throwaway database directory, and AI runs in
// degraded mode. The user's real server/data/ is never touched by tests.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draw-test-"));
delete process.env.ANTHROPIC_API_KEY;
