import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The production entry's fail-loud guard (#189, ADR-49): without a client
// build, `npm start` must refuse to boot — a silent start would 404 every
// page view. Spawned as the real process because the guard's contract IS the
// exit code; CLIENT_DIR points at an empty directory so the check fails
// regardless of whether a real client/dist exists on this machine.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "../..");
const tsxCli = path.resolve(serverRoot, "../node_modules/tsx/dist/cli.mjs");

describe("production entry guard", () => {
  it("exits 1 with a build hint when the client build is missing", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-no-build-"));
    try {
      const child = spawn(process.execPath, [tsxCli, "src/prod.ts"], {
        cwd: serverRoot,
        env: {
          ...process.env, // carries this test file's throwaway DATA_DIR
          CLIENT_DIR: emptyDir,
          ANTHROPIC_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("no client build");
      expect(stderr).toContain("npm run build");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
