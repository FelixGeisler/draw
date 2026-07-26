import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The container runtime contract (#191, ADR-51). The image runs the ADR-49
// production entry as one process — `node --import tsx src/prod.ts` — with
// CLIENT_DIR pointing at the copied client build, HOST exported, DATA_DIR on a
// volume, and a healthcheck polling GET /api/health. This boots that EXACT
// invocation as a real OS process against a real socket (what `docker run`
// does) and hits the two endpoints the container depends on: /api/health (the
// healthcheck target, above the password gate) and / (the served client).
// production-serve.test.ts covers createApp() in-process via supertest; this
// proves the process the Dockerfile launches actually serves them.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(serverRoot, "..");
const INDEX_MARKER = "draw-container-index-marker";

// Spawn EXACTLY what the Dockerfile CMD launches, parsed from the Dockerfile
// itself (not hardcoded) so a CMD change — e.g. dropping `--import tsx` — is
// exercised here: bare `node src/prod.ts` cannot load TypeScript, so the health
// poll below would never come up and the suite would fail. The leading "node"
// is dropped; we spawn process.execPath as node.
function containerCmdArgs(): string[] {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
  const m = dockerfile.match(/^CMD\s+(\[.*\])\s*$/m);
  if (!m) throw new Error("Dockerfile has no exec-form CMD to mirror");
  const cmd = JSON.parse(m[1]) as string[];
  return cmd[0] === "node" ? cmd.slice(1) : cmd;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(url: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`health never came up at ${url}: ${String(lastErr)}`);
}

describe("container runtime contract", () => {
  let child: ChildProcess;
  let clientDir: string;
  let dataDir: string;
  let port: number;
  let stderr = "";

  beforeAll(async () => {
    // Stand-in for the vite client build the container copies to CLIENT_DIR.
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-cont-client-"));
    fs.writeFileSync(
      path.join(clientDir, "index.html"),
      `<!doctype html><html><body>${INDEX_MARKER}</body></html>`,
    );
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-cont-data-"));
    port = await freePort();

    child = spawn(process.execPath, containerCmdArgs(), {
      cwd: serverRoot,
      env: {
        ...process.env,
        CLIENT_DIR: clientDir,
        DATA_DIR: dataDir,
        // Loopback, not the container's 0.0.0.0: still exercises the HOST env
        // → resolveHost → listen(host) path in the real process, without
        // binding a LAN port (firewall prompts, macOS EADDRNOTAVAIL).
        // resolveHost({ HOST: "0.0.0.0" }) is unit-covered in config.test.ts.
        HOST: "127.0.0.1",
        API_PORT: String(port),
        ANTHROPIC_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (c) => (stderr += String(c)));

    try {
      await waitForHealth(`http://127.0.0.1:${port}/api/health`, 25_000);
    } catch (err) {
      throw new Error(`${String(err)}\n--- server stderr ---\n${stderr}`);
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    // Give the process a moment to release the SQLite file before cleanup so
    // the temp-dir removal does not race a live handle on Windows.
    await new Promise((r) => setTimeout(r, 200));
    for (const dir of [clientDir, dataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a lingering handle just leaves a temp dir behind.
      }
    }
  });

  it("answers the healthcheck target /api/health with {ok:true}", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; time: string };
    expect(body.ok).toBe(true);
    expect(typeof body.time).toBe("string");
  });

  it("serves the client build from CLIENT_DIR at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_MARKER);
  });

  it("does not print the LAN-exposure warning on a loopback bind", () => {
    // Bound to 127.0.0.1 with no DRAW_PASSWORD: the #191 guardrail must stay
    // silent (config.test.ts covers the firing case for a non-loopback host).
    expect(stderr).not.toContain("WARNING: bound to");
  });
});
