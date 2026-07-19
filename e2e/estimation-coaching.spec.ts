import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { captureForm } from "./helpers.js";

// Estimation coaching (#55, ADR-27): a passive hint under TaskForm's effort
// field and per-category bias statements on the Stats page. History arises
// from the real user flows only (task POST, timer routes, PATCH status done —
// no direct DB seeding), which keeps tracked time near zero: the seeded
// category therefore carries a consistent, strongly divergent ratio of 0×.
// Everything asserts against OWN categories so the shared serial database's
// other specs can never skew the sample.
test.describe.configure({ mode: "serial" });

const COACHED = "Coached cat";
const UNCOACHED = "Uncoached cat";

const SEED_TITLES = ["Coach seed A", "Coach seed B", "Coach seed C"];

async function seedBiasHistory(request: APIRequestContext) {
  const coached = await (
    await request.post("/api/categories", { data: { name: COACHED, color: "#ff8c5f" } })
  ).json();
  // A category the coach must stay silent about: it exists, but has no
  // completed-and-tracked history (below MIN_SAMPLE).
  await request.post("/api/categories", { data: { name: UNCOACHED, color: "#5fd3ff" } });

  // Three qualifying tasks: estimated 60 min, tracked a few real seconds via
  // the timer routes, completed. Consistent bias, sample size 3 = MIN_SAMPLE.
  for (const title of SEED_TITLES) {
    const task = await (
      await request.post("/api/tasks", {
        data: { title, categoryId: coached.id, effortMinutes: 60 },
      })
    ).json();
    await request.post(`/api/tasks/${task.id}/timer/start`);
    // The tracked cycle must own > 0 minutes to qualify — give the entry a
    // measurable duration instead of racing start/stop within the same ms.
    await new Promise((r) => setTimeout(r, 300));
    await request.post("/api/timer/stop");
    await request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });
  }
}

/**
 * Shared-DB hygiene (#103). The seeds above are the heaviest residue any spec
 * in this suite leaves: THREE completions in the serial database, which arm
 * the momentum bonus (×1.25 for 30 wall-clock minutes) under every later
 * exact-XP assert and add three cards to today's trophy pile — and the pile is
 * a centered non-wrapping flex row, so every extra card shrinks ALL of them
 * until the trophy specs' hover centers drift under their right neighbours
 * (see elsewhere-completion.spec.ts). Deleting the tasks cascades their
 * completions and time entries away; the now-empty categories follow, so the
 * Tasks page sections and the draw filter chips read as before too.
 *
 * Called at the end of the last test rather than from an afterAll hook: the
 * `request` fixture is test-scoped, and this file already cleans up in-test.
 */
async function cleanupBiasHistory(request: APIRequestContext) {
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const title of SEED_TITLES) {
    const task = tasks.find((t) => t.title === title);
    if (task) await request.delete(`/api/tasks/${task.id}`);
  }
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  for (const name of [COACHED, UNCOACHED]) {
    const category = categories.find((c) => c.name === name);
    if (category) await request.delete(`/api/categories/${category.id}`);
  }
}

// The quick-capture form on the merged Tasks page (#151) — scoped by testid:
// an open row editor elsewhere on the page would make bare form locators
// ambiguous.
function form(page: Page) {
  return captureForm(page).locator("form");
}
const categorySelect = (page: Page) => form(page).locator("select").first();
const effortInput = (page: Page) => form(page).getByPlaceholder("min");
const hint = (page: Page) => page.getByTestId("estimate-hint");

test("TaskForm shows the passive hint only while its preconditions hold", async ({ page }) => {
  await seedBiasHistory(page.request);
  await page.goto("/tasks");

  // Divergent estimate in the coached category → the hint appears. Tracked
  // ~0 min against 180 estimated makes the all-history ratio exactly 0, so
  // the suggestion is pinned at the 5-minute floor.
  await categorySelect(page).selectOption({ label: COACHED });
  await effortInput(page).fill("40");
  await expect(hint(page)).toHaveText(
    `history suggests ~5 min (you track 0× your ${COACHED} estimates)`,
  );
  // Advice that appears silently under the field the user is typing in is
  // advice a screen reader never mentions (#103). Polite, never assertive:
  // it waits for a pause in typing, like the visual hint waits to be noticed.
  await expect(hint(page)).toHaveAttribute("aria-live", "polite");

  // …but it stays silent when the rounded suggestion IS what was typed
  // (#103): at 5 the ratio-0 suggestion floors right back to 5, and "history
  // suggests ~5 min" under a 5 corrects nothing.
  await effortInput(page).fill("5");
  await expect(hint(page)).toHaveCount(0);
  await effortInput(page).fill("40");
  await expect(hint(page)).toBeVisible();

  // Switching to a category without history removes it...
  await categorySelect(page).selectOption({ label: UNCOACHED });
  await expect(hint(page)).toHaveCount(0);

  // ...switching back restores it, clearing the estimate removes it again.
  await categorySelect(page).selectOption({ label: COACHED });
  await expect(hint(page)).toBeVisible();
  await effortInput(page).fill("");
  await expect(hint(page)).toHaveCount(0);
});

test("the hint never rewrites the field or the submitted estimate", async ({ page }) => {
  await page.goto("/tasks");
  await categorySelect(page).selectOption({ label: COACHED });
  await form(page).getByPlaceholder("What needs doing?").fill("Passivity probe");
  await effortInput(page).fill("40");
  await expect(hint(page)).toBeVisible();

  // The field still holds exactly what was typed, hint or no hint.
  await expect(effortInput(page)).toHaveValue("40");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The stored task carries the user's 40 — not the suggested 5.
  await expect(async () => {
    const tasks = (await (await page.request.get("/api/tasks")).json()) as {
      id: number;
      title: string;
      effortMinutes: number | null;
    }[];
    const probe = tasks.find((t) => t.title === "Passivity probe");
    expect(probe?.effortMinutes).toBe(40);
  }).toPass();

  // Leave no residue in the shared DB for later spec files.
  const tasks = (await (await page.request.get("/api/tasks")).json()) as {
    id: number;
    title: string;
  }[];
  await page.request.delete(`/api/tasks/${tasks.find((t) => t.title === "Passivity probe")!.id}`);
});

test("the Stats page states the coached category's bias, threshold met", async ({ page }) => {
  await page.goto("/stats");

  // The three seeds completed just now sit inside the default 7-day range;
  // ratio 0 < 0.9 reads as over-estimating.
  const statement = page.getByTestId("bias-statement").filter({ hasText: COACHED });
  await expect(statement).toHaveText(
    `${COACHED}: tracked 0× estimated over 3 tasks — your ${COACHED} estimates run high, trim them.`,
  );

  // No statement for any category below the minimum sample — the uncoached
  // category must not even appear as a placeholder.
  await expect(page.getByTestId("bias-statement").filter({ hasText: UNCOACHED })).toHaveCount(0);

  // Last assertion of the file — the seeds have served their purpose, so the
  // shared database gets them back clean (see cleanupBiasHistory). The reload
  // proves it: the statement derives from completions, so it can only vanish
  // if the history really did.
  await cleanupBiasHistory(page.request);
  await page.reload();
  await expect(page.getByTestId("bias-statement").filter({ hasText: COACHED })).toHaveCount(0);
});
