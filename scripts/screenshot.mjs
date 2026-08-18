// Regenerate the README screenshots (#211).
//
//   npm run build && node scripts/screenshot.mjs
//
// Boots the real production server against a THROWAWAY DATA_DIR, seeds a
// small believable board through the public API, draws a card, and shoots the
// three views the README leads with. Never touches server/data — the temp
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

// One coherent board. DELIBERATELY generic workplace examples (#218): these
// images are the project's shop window, and seed data that reads like
// somebody's personal life does not belong in it. Effort/impact are chosen so
// the drawn card shows a star row and a short estimate, every card stays at
// or under max_draw_effort (30 — a bigger estimate would put the task in the
// "Too big" nag section and OUT of the deck), and the 5★ goal-linked card
// DOMINATES the draw weights (impact²/effort ⇒ 1.67 : 0.53 : 0.36 : 0.20
// ≈ 60%): draw.png is the README hero, and the holo sheen on a drawn 5★
// goal-linked card is the product's signature (#123), so the shot must land
// it (see the attempt loop below).
// Target date ~6 weeks out from whenever the script runs: a fixed date would
// eventually drift into the past and dress the shot in red overdue chips.
const targetDate = new Date(Date.now() + 42 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const GOAL = {
  title: "Launch the next release",
  outcome: "Shipped to every customer by the target date",
  targetDate,
};
const TASKS = [
  { title: "Rehearse the launch demo", effortMinutes: 15, impact: 5 },
  { title: "Draft the release notes", effortMinutes: 30, impact: 4 },
  { title: "Review the pricing page", effortMinutes: 25, impact: 3 },
  { title: "Update the onboarding email", effortMinutes: 20, impact: 2 },
];
// Two resolved goals so the Goals shot shows the Hall of Fame doing its job —
// consecutive ids land on different trophy designs by construction (ADR-58).
const ACHIEVED = ["Pass the security audit", "Migrate the build to the new CI"];

// A draw can never be re-rolled in-app — the draw is a commitment, by design.
// This script owns a throwaway world, so a "re-roll" is honest here: when the
// random draw lands a non-holo card, tear the whole board down and deal a
// fresh one. At ~60% per attempt, six attempts miss with p ≈ 0.4⁶ ≈ 0.4%.
const MAX_ATTEMPTS = 6;

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

function bootServer(dataDir) {
  const server = spawn(process.execPath, ["--import", "tsx", "src/prod.ts"], {
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
  });
  server.on("exit", (code) => {
    if (code) console.error(`server exited early with ${code}`);
  });
  return server;
}

// The next attempt reuses the port, so "stopped" must mean EXITED, not
// signalled.
const stopServer = (server) =>
  new Promise((resolve) => {
    if (!server || server.exitCode != null) return resolve();
    server.once("exit", resolve);
    server.kill();
  });

async function seed() {
  const categories = await (await fetch(`${BASE}/api/categories`)).json();
  const categoryId = categories[0].id;
  const goal = await post("/api/goals", GOAL);
  for (const t of TASKS) await post("/api/tasks", { ...t, categoryId, goalId: goal.id });
  for (const title of ACHIEVED) {
    const g = await post("/api/goals", { title });
    const res = await fetch(`${BASE}/api/goals/${g.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "achieved" }),
    });
    if (!res.ok) throw new Error(`achieve goal → ${res.status}`);
  }
}

async function main() {
  if (!fs.existsSync(path.join(repoRoot, "client/dist/index.html"))) {
    throw new Error("client/dist is missing — run `npm run build` first");
  }
  fs.mkdirSync(outDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-shot-"));
    let server;
    let browser;
    try {
      server = bootServer(dataDir);
      await waitForHealth();
      await seed();

      browser = await chromium.launch();
      const page = await browser.newPage({
        // Sized to the content, not to a laptop: the Draw page is one centered
        // card, so a taller frame just adds empty charcoal under the buttons.
        viewport: { width: 1280, height: 760 },
        deviceScaleFactor: 2, // retina — the card art and the holo sheen need it
      });

      // Draw: click the deck's front face and let the flip settle. The
      // animation is the product's signature, so a mid-flip frame would
      // undersell it.
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.locator(".draw-face.front").click();
      await page.locator(".draw-card.flipped").waitFor();
      if ((await page.locator(".draw-holo").count()) === 0) {
        console.log(`attempt ${attempt}: drew a non-holo card — dealing a fresh board`);
        continue;
      }
      // The deal (#255) is a ~560ms arc plus a delayed one-shot 900ms gilt
      // sweep — longer than the flat settle below, so wait for every FINITE
      // animation on the scene to finish (the holo drift loops forever and
      // must be excluded, it is the shot's whole point).
      await page.locator(".draw-scene").evaluate((el) =>
        Promise.all(
          el
            .getAnimations({ subtree: true })
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        ),
      );
      // The first draw unlocks an achievement, and its toast sits over the
      // action row — a shot taken under it loses the last button. The toast
      // self-dismisses after 4s (AchievementToast.tsx), so wait it out rather
      // than suppressing it.
      await page
        .locator(".ach-toast")
        .last()
        .waitFor({ state: "detached", timeout: 15_000 })
        .catch(() => {});
      // The click left the pointer ON the card, which engages the #255 hover
      // tilt — park it away and let the ~260ms release settle so the hero
      // shows the card seated on the felt, not mid-hover.
      await page.mouse.move(0, 0);
      await wait(600);
      await page.screenshot({ path: path.join(outDir, "draw.png") });

      // The Tasks page — back in the set now that #213 made the rows read
      // cleanly (a long goal chip used to crush every title into a tower).
      // Hover a mid-list row ON PURPOSE: since #244 the action cluster is
      // hidden at rest, and the shot should show the hover reveal doing its
      // job rather than four rows of bare titles.
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle" });
      await page.locator(".task-row").filter({ hasText: "Review the pricing page" }).hover();
      await wait(400);
      await page.screenshot({ path: path.join(outDir, "tasks.png") });

      // Goals: the active goal above, the Hall of Fame with its trophy
      // variants (ADR-58) below — two resolved goals guarantee two designs.
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.goto(`${BASE}/goals`, { waitUntil: "networkidle" });
      await wait(400);
      await page.screenshot({ path: path.join(outDir, "goals.png") });

      console.log(`wrote draw.png, tasks.png, goals.png to ${outDir}`);
      return;
    } finally {
      await browser?.close().catch(() => {});
      await stopServer(server);
      await wait(400);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  throw new Error(
    `no holo draw in ${MAX_ATTEMPTS} attempts — a ~0.4% outcome; check the seeded weights`,
  );
}

await main();
