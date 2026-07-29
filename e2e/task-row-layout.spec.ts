import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { taskTree } from "./helpers.js";

// Issue #213: a long goal chip used to crush the task title to min-content —
// five-line title towers next to an ellipsis-less chip, at ANY viewport width
// (the .content cap means the row never gets wider than ~880px, so a bigger
// window never helped). Two rules now hold, and this pins both:
//   - the goal chip clamps (its full text stays in the tooltip), and
//   - the title keeps a readable floor; past it the BADGES wrap, not the title.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE =
  "Publish the complete advanced e2e correspondence course with all supplementary material";
const TASK_TITLE = "Sand and oil the e2e box";

// A REALISTIC goal-linked row: effort chip, goal chip, impact stars. The
// badge-heavy extreme (due date + recurrence + window on top) is test 2's
// job, where the promise is a different one.
async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: {
      title: TASK_TITLE,
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 15,
      impact: 2,
    },
  });
}

test("a long goal chip clamps instead of crushing the title", async ({ page }) => {
  await seed(page.request);
  await page.goto("/tasks");

  const row = taskTree(page).getByText(TASK_TITLE, { exact: true }).locator("..");
  await expect(row).toBeVisible();

  // The chip is clamped: rendered narrower than its text wants, ellipsis
  // doing the eliding (scrollWidth > clientWidth is what text-overflow
  // actually does), with the full goal one hover away.
  const chip = row.locator(".chip-clip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", `Linked to goal: ${GOAL_TITLE}`);
  const geom = await chip.evaluate((el) => ({
    display: getComputedStyle(el).display,
    maxWidth: getComputedStyle(el).maxWidth,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    width: Math.round(el.getBoundingClientRect().width),
  }));
  // A flex item blockifies inline-block, so computed display reads "block" —
  // what matters is that it is NOT a flex container, since text-overflow only
  // elides inline content, never flex items.
  expect(geom.display).not.toContain("flex");
  expect(geom.width).toBeLessThanOrEqual(152);
  // text-overflow eliding is literally scrollWidth exceeding clientWidth.
  expect(geom.scrollWidth).toBeGreaterThan(geom.clientWidth);

  // The title renders on ONE line — the row exists to show it. Compare the
  // span's height against its own computed line-height rather than a magic
  // pixel count, so a type-scale change cannot silently break the assertion.
  const titleSpan = row.getByText(TASK_TITLE, { exact: true });
  const title = await titleSpan.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      height: el.getBoundingClientRect().height,
      // line-height computes to the keyword "normal" here (parseFloat → NaN),
      // so the one-line bound is derived from font-size instead: a single
      // line is ~1.2–1.4× font-size, a second line puts it past 2×.
      fontSize: parseFloat(s.fontSize),
    };
  });
  expect(title.height).toBeLessThan(title.fontSize * 2);
});

test("when badges overflow, they yield — never the title", async ({ page }) => {
  // Load the row up: due date + recurrence + window on top of the goal chip
  // and stars. This row genuinely does not fit one line, and the promise
  // here is WHO yields: the badges span wraps internally, while the title
  // keeps its readable floor instead of collapsing to a word per line.
  const tasks: { id: number; title: string }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  const task = tasks.find((t) => t.title === TASK_TITLE)!;
  const res = await page.request.patch(`/api/tasks/${task.id}`, {
    data: {
      dueDate: "2036-01-01",
      recurEveryDays: 7,
      windowDays: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    },
  });
  if (!res.ok()) throw new Error(`seed: patch failed (${res.status()})`);

  await page.goto("/tasks");
  const row = taskTree(page).getByText(TASK_TITLE, { exact: true }).locator("..");
  const titleSpan = row.getByText(TASK_TITLE, { exact: true });
  const floorHolds = await titleSpan.evaluate((el) => {
    const s = getComputedStyle(el);
    const fontSize = parseFloat(s.fontSize);
    // The 11em floor, measured — with a little slack for rounding.
    return el.getBoundingClientRect().width >= fontSize * 10.5;
  });
  expect(floorHolds).toBe(true);
});

test.afterAll(async ({ request }) => {
  // Shared suite database: a leaked drawable task changes later draws.
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title === TASK_TITLE)) {
    await request.delete(`/api/tasks/${t.id}`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const g of goals.filter((g) => g.title === GOAL_TITLE)) {
    await request.delete(`/api/goals/${g.id}`);
  }
});
