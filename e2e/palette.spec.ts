import { expect, test } from "@playwright/test";
import { captureForm, drawFromGoal, resolveCurrentDraw, taskTree } from "./helpers.js";

// #243 command palette + global shortcuts, written TEST-FIRST. One serial
// journey keeps the E2E budget flat: capture proves key-inertness while
// typing, then the palette is exercised from a DIFFERENT page (that is its
// whole point — global reach), then each global key gets one focused check.
// Everything selection/command-shaped is unit-level in client/src/lib/paletteNav
// and keyScope; this file proves only the wiring a DOM-less suite cannot.
// Contract testids: command-palette, palette-input, palette-result,
// shortcut-sheet.
test.describe.configure({ mode: "serial" });

// The title deliberately contains d, n, k and spaces — every letter that is
// (or sits next to) a global key rides through the input as plain typing.
const TASK_TITLE = "Dandelion band sound check";

test("typing d, n and spaces into quick capture stays typing — global keys are inert", async ({
  page,
}) => {
  // A running timer left by an earlier spec would blur the space assertion.
  await page.request.post("/api/timer/stop").catch(() => {});

  await page.goto("/tasks");
  const title = captureForm(page).getByPlaceholder("What needs doing?");
  await title.click();
  // Real per-key events (not fill): each keydown must reach the input, not
  // the global handler.
  await title.pressSequentially(TASK_TITLE);
  await expect(title).toHaveValue(TASK_TITLE);

  // 'd' did not navigate to the draw page, spaces did not touch the timer,
  // and no overlay opened.
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await expect(page.getByTestId("shortcut-sheet")).toBeHidden();
  expect(await (await page.request.get("/api/timer/current")).json()).toBeNull();

  await captureForm(page).getByTitle("Effort estimate in minutes").fill("15");
  await captureForm(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(title).toHaveValue("");
  await expect(taskTree(page).getByText(TASK_TITLE)).toBeVisible();
});

test("Ctrl+K on Stats opens the palette; search + Enter lands on the task's row on /tasks", async ({
  page,
}) => {
  await page.goto("/stats");
  await page.keyboard.press("Control+k");

  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  // Empty query = the Actions group, the shortcut discovery surface.
  await expect(palette.getByText("Draw a card")).toBeVisible();
  await expect(palette.getByText("Capture a task")).toBeVisible();

  await input.pressSequentially("Dandelion band");
  const result = page.getByTestId("palette-result").filter({ hasText: TASK_TITLE });
  await expect(result).toBeVisible();

  // Exactly one result matches this title, so ArrowDown deterministically
  // selects it whether or not the palette pre-selects the first row
  // (moveSelection's single-entry invariant, pinned in paletteNav.test.ts).
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/tasks/);
  // Scrolled into view with a transient highlight; the row being visible in
  // the tree is the stable, animation-agnostic half of that promise.
  await expect(taskTree(page).getByText(TASK_TITLE)).toBeVisible();
});

test("Ctrl+Enter on a task result starts its timer and closes the palette", async ({ page }) => {
  await page.goto("/stats");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").pressSequentially("Dandelion band");
  await expect(page.getByTestId("palette-result").filter({ hasText: TASK_TITLE })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+Enter");

  await expect(page.getByTestId("command-palette")).toBeHidden();
  // The globally mounted TimerBar shows the running task on this very page.
  await expect(page.locator(".timer-bar")).toBeVisible();
  await expect(page.locator(".timer-title")).toHaveText(TASK_TITLE);
  const timer = await (await page.request.get("/api/timer/current")).json();
  expect(timer.task.title).toBe(TASK_TITLE);
  expect(timer.entry.endedAt).toBeNull();
});

test("space on a focused link belongs to the element — the timer keeps running", async ({
  page,
}) => {
  await page.goto("/stats");
  await expect(page.locator(".timer-bar")).toBeVisible();

  // Space is the native activation key of focused controls: on a focused
  // button/link the global timer toggle must yield (keyScope's
  // isSpaceActivationTarget), or a keyboard user pressing Space to click
  // would silently stop their timer AND lose the click to preventDefault.
  await page.locator("nav.sidenav a").first().focus();
  await page.keyboard.press("Space");

  await expect(page.locator(".timer-bar")).toBeVisible();
  const timer = await (await page.request.get("/api/timer/current")).json();
  expect(timer.task.title).toBe(TASK_TITLE);
  expect(timer.entry.endedAt).toBeNull();
});

test("space outside any input stops the running timer", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.locator(".timer-bar")).toBeVisible();

  await page.keyboard.press("Space");

  await expect(page.locator(".timer-bar")).toBeHidden();
  expect(await (await page.request.get("/api/timer/current")).json()).toBeNull();
});

test("Esc closes the palette and returns focus to the element that had it", async ({ page }) => {
  await page.goto("/tasks");
  const title = captureForm(page).getByPlaceholder("What needs doing?");
  await title.click();
  await expect(title).toBeFocused();

  // Ctrl+K is a chord, not a single letter — it opens even from inside an
  // input (only the single-key shortcuts are inert there).
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await expect(title).toBeFocused();
});

test("? opens the shortcut sheet; Escape closes it", async ({ page }) => {
  await page.goto("/stats");
  await page.keyboard.press("?");

  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toBeVisible();
  // The sheet lists every global key — loose text checks, no layout pinning.
  await expect(sheet.getByText(/capture/i)).toBeVisible();
  await expect(sheet.getByText(/timer/i)).toBeVisible();
  await expect(sheet.getByText(/draw/i)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("n jumps to Tasks and focuses quick capture", async ({ page }) => {
  await page.goto("/stats");
  await page.keyboard.press("n");

  await expect(page).toHaveURL(/\/tasks/);
  await expect(captureForm(page).getByPlaceholder("What needs doing?")).toBeFocused();
});

test("d goes to the Draw page and never deals a card", async ({ page }) => {
  // A draw is a commitment (#88): a stray keypress must not gamble for the
  // user, so 'd' lands on the idle face-down deck, focused but unflipped.
  await resolveCurrentDraw(page);
  await page.goto("/stats");
  await page.keyboard.press("d");

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  const current = await (await page.request.get("/api/draw/current")).json();
  expect(current?.task ?? null).toBeNull();
});

test("Ctrl+K yields to a running focus session — no invisible palette underneath", async ({
  page,
}) => {
  // Seed one drawable task under its own goal so the draw is deterministic,
  // then enter focus mode for real (the z-90 overlay that owns #root's inert).
  const goal = await (
    await page.request.post("/api/goals", { data: { title: "Palette focus-gate goal" } })
  ).json();
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  await page.request.post("/api/tasks", {
    data: {
      title: "Palette focus-gate task",
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 5,
    },
  });
  await drawFromGoal(page, "Palette focus-gate goal");
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  const overlay = page.locator(".focus-overlay");
  await expect(overlay).toBeVisible();

  // The chord must NOT open the palette under the session (z 85 < 90): an
  // invisible dialog would steal every keystroke, and closing it again would
  // strip the session's inert, reviving shortcuts under the covered page.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await expect(overlay).toBeVisible();
  const timerDuring = await (await page.request.get("/api/timer/current")).json();
  expect(timerDuring.task.title).toBe("Palette focus-gate task");

  // Escape leaves the VIEW only (timer keeps running) — now the chord works.
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();

  // Leave the shared serial DB the way this spec found it: timer stopped,
  // no persisted draw.
  await page.request.post("/api/timer/stop");
  await resolveCurrentDraw(page);
});
