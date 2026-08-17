import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Regions of the merged Tasks page (#151). A needs-estimate or too-big task
 * renders TWICE — once in the triage strip, once in its category group — so
 * page-wide title lookups go ambiguous. Scope row work to the tree and
 * capture work to the form; the strip has its own testid for triage asserts.
 * The subtask editor's testid disambiguates its "min" inputs from the
 * quick-capture form's and the strip's inline estimate inputs.
 */
export function captureForm(page: Page): Locator {
  return page.getByTestId("capture-form");
}
export function triageStrip(page: Page): Locator {
  return page.getByTestId("triage-strip");
}
export function taskTree(page: Page): Locator {
  return page.getByTestId("task-tree");
}
export function subtaskEditor(page: Page): Locator {
  return page.getByTestId("subtask-editor");
}

/**
 * Open a task row's overflow menu (#244): the kebab ("More actions") holds
 * the relocated "Move under…" and "Delete" actions. Playwright's click
 * hovers first, which is what reveals the opacity-hidden .row-actions
 * cluster — no explicit hover needed. Returns the popover, scoped to the
 * page (it is the only .row-menu that can be open at a time).
 */
export async function openRowMenu(row: Locator): Promise<Locator> {
  await row.getByRole("button", { name: "More actions", exact: true }).click();
  const menu = row.page().locator(".row-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Resolve a current draw persisted by an earlier serial spec (issue #25).
 * Since #88 the draw is a commitment — there is no "Draw again", and a
 * restored card blocks the idle front face. Resolution mirrors the product's
 * escape hatch: blocking ("Not now") takes the card out of the deck and
 * eagerly clears the persisted pointer (ADR-17); the immediate wake keeps the
 * task itself drawable, because some specs re-draw the very task their
 * leftover card shows (their goal-scoped pool holds exactly that one card).
 */
export async function resolveCurrentDraw(page: Page) {
  const current = await (await page.request.get("/api/draw/current")).json();
  if (current?.task) {
    const block = await page.request.patch(`/api/tasks/${current.task.id}`, { data: { blocked: true } });
    if (!block.ok()) throw new Error(`resolveCurrentDraw: block failed (${block.status()})`);
    const wake = await page.request.patch(`/api/tasks/${current.task.id}`, { data: { blocked: false } });
    if (!wake.ok()) throw new Error(`resolveCurrentDraw: wake failed (${wake.status()})`);
  }
}

/**
 * Select the goal filter and draw — deterministic for specs that seed exactly
 * one drawable task under their own goal. A leftover persisted draw is
 * resolved first so the idle front face is clickable. Ends on the flipped
 * card; callers assert the title themselves.
 */
export async function drawFromGoal(page: Page, goalTitle: string) {
  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${goalTitle}` });
  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
}
