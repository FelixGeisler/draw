// Regenerate the README screenshots (#211).
//
//   npm run build && node scripts/screenshot.mjs
//
// Boots the real production server against a THROWAWAY DATA_DIR, seeds a
// small believable board through the public API, draws a card, and shoots the
// two views the README leads with. Never touches server/data — the temp
// directory is created fresh and removed at the end, so running this can
// neither read nor damage real tasks.
//
// Deliberately a script and not a Playwright spec: the E2E suite shares one
// database with 160+ specs, and seeding photogenic data into it would change
// what every other spec draws.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, ".github", "assets");
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

// One coherent board: a goal worth having, a few real-sounding steps, and one
// small drawable card that will be the hero shot. Effort/impact are chosen so
// the drawn card shows a full star row and a short estimate.
const GOAL = { title: "Ship the woodworking course", outcome: "8 lessons published and paid for" };
const TASKS = [
  { title: "Storyboard lesson 3", effortMinutes: 25, impact: 5 },
  { title: "Record the dovetail demo", effortMinutes: 30, impact: 4 },
  { title: "Edit the intro titles", effortMinutes: 20, impact: 3 },
  { title: "Sand and oil the sample box", effortMinutes: 15, impact: 2 },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await wait(300);
  }
  throw new Error(`server never became healthy on ${BASE}`);
}

const post = (p, body) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-shot-"));
let server;

try {
  if (!fs.existsSync(path.join(repoRoot, "client/dist/index.html"))) {
    throw new Error("client/dist is missing — run `npm run build` first");
  }
  fs.mkdirSync(outDir, { recursive: true });

  server = spawn(
    process.execPath,
    ["--import", "tsx", "src/prod.ts"],
    {
      cwd: path.join(repoRoot, "server"),
      // No DRAW_PASSWORD and no ANTHROPIC_API_KEY: the shots show the app as a
      // first-time reader meets it, and an AI panel would advertise a key.
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        CLIENT_DIR: path.join(repoRoot, "client/dist"),
        HOST: "127.0.0.1",
        API_PORT: String(PORT),
        DRAW_PASSWORD: "",
        ANTHROPIC_API_KEY: "",
        BACKUP_INTERVAL_HOURS: "0",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  server.on("exit", (code) => {
    if (code) console.error(`server exited early with ${code}`);
  });

  await waitForHealth();

  const categories = await (await fetch(`${BASE}/api/categories`)).json();
  const categoryId = categories[0].id;
  const goal = await post("/api/goals", GOAL);
  for (const t of TASKS) await post("/api/tasks", { ...t, categoryId, goalId: goal.id });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    // Sized to the content, not to a laptop: the Draw page is one centered
    // card, so a taller frame just adds empty charcoal under the buttons.
    viewport: { width: 1280, height: 760 },
    deviceScaleFactor: 2, // retina — the card art and the holo sheen need it
  });

  // Draw: click the deck's front face and let the flip settle. The animation
  // is the product's signature, so a mid-flip frame would undersell it.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator(".draw-face.front").click();
  await page.locator(".draw-card.flipped").waitFor();
  // The first draw unlocks an achievement, and its toast sits over the action
  // row — a shot taken under it loses the last button. The toast self-dismisses
  // after 4s (AchievementToast.tsx), so wait it out rather than suppressing it.
  await page
    .locator(".ach-toast")
    .last()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});
  await wait(600);
  await page.screenshot({ path: path.join(outDir, "draw.png") });

  // Deliberately only the Draw page. A Tasks-page shot was tried and dropped:
  // the row's title column has no flex-grow, so it collapses to its minimum
  // and every title wraps to four or five lines regardless of viewport width
  // (reproduced at 1280 and 1600). That is a layout defect to fix on its own
  // terms, not something to hide behind a hand-picked window size — add the
  // shot back here once the rows read cleanly.

  await browser.close();
  console.log(`wrote ${path.join(outDir, "draw.png")}`);
} finally {
  server?.kill();
  await wait(400);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
