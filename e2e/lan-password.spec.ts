import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The LAN password gate (#190, ADR-50) end to end: a production server with
// DRAW_PASSWORD set, booted by THIS spec — the shared webServer entries in
// playwright.config.ts all run without auth, and a fourth entry would race
// entry #3's `npm run build` for client/dist. By the time specs run, that
// build is finished, so spawning prod.ts directly here is race-free.
//
// Teardown note (Windows): the tsx CLI does NOT run the server in this direct
// child — it forks a distinct grandchild that actually binds the port.
// server.kill() reaches only the tsx parent; the grandchild dies with it
// because libuv puts each spawned process in a Windows job object whose
// kill-on-close cascades to descendants. So the port is released cleanly here
// precisely BECAUSE we do not detach — a future `detached: true` would break
// the child out of that job and orphan the port-holder.

const AUTH_PORT = process.env.E2E_AUTH_PORT || "3103";
const BASE = `http://127.0.0.1:${AUTH_PORT}`;
const PASSWORD = "e2e-lan-pin-42";

const serverRoot = path.resolve(__dirname, "..", "server");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

let server: ChildProcess;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-e2e-auth-"));
  server = spawn(process.execPath, [tsxCli, "src/prod.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      API_PORT: AUTH_PORT,
      HOST: "", // pin loopback regardless of ambient exports
      DRAW_PASSWORD: PASSWORD,
      ANTHROPIC_API_KEY: "", // AI-degraded like the rest of the suite
    },
    stdio: "ignore",
  });

  // Poll /api/health — open WITHOUT credentials by design (ADR-50), which is
  // exactly what lets healthchecks like this one work on a protected server.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`auth server exited early (code ${server.exitCode})`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error("auth server did not become healthy in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function logIn(page: Page) {
  await page.goto(`${BASE}/`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator(".sidenav .brand")).toHaveText("🃏 Draw");
}

test.describe("LAN password gate", () => {
  test("unauthenticated page views land on the login page, not the app", async ({ page }) => {
    const response = await page.goto(`${BASE}/stats`);
    expect(response?.status()).toBe(401);
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.locator(".sidenav .brand")).toHaveCount(0);
  });

  test("unauthenticated API requests 401; /api/health stays open", async ({ request }) => {
    const tasks = await request.get(`${BASE}/api/tasks`);
    expect(tasks.status()).toBe(401);
    expect(await tasks.json()).toEqual({ error: "authentication required" });

    const health = await request.get(`${BASE}/api/health`);
    expect(health.ok()).toBeTruthy();
  });

  test("a wrong password is rejected on the login page", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.getByLabel("Password").fill("not-the-pin");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("alert")).toHaveText("invalid password");
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("the correct password unlocks the app and the core flow works", async ({ page }) => {
    await logIn(page);

    // The session cookie carries a full page load — deep link straight to
    // the tasks page and use the app for real.
    await page.goto(`${BASE}/tasks`);
    const form = page.getByTestId("capture-form");
    await form.getByPlaceholder("What needs doing?").fill("Water the LAN plants");
    await form.getByTitle("Effort estimate in minutes").fill("10");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByTestId("task-tree").getByText("Water the LAN plants"),
    ).toBeVisible();

    // And the API agrees, through the same authenticated browser context.
    const tasks = await page.request.get(`${BASE}/api/tasks`);
    expect(tasks.ok()).toBeTruthy();
    expect((await tasks.json()).map((t: { title: string }) => t.title)).toContain(
      "Water the LAN plants",
    );
  });
});
