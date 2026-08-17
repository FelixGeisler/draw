import { expect, test } from "@playwright/test";
import { captureForm, subtaskEditor, taskTree, triageStrip } from "./helpers.js";

// The merged Tasks page (#151, ADR-40): capture, triage and the category tree
// are ONE surface. These journeys pin the merge's contract — the rapid-entry
// ritual survives capture-first (Enter submits, fields reset, focus stays),
// the triage strip lists only actionable rows and each row's fix makes it
// leave the strip, and the tree below keeps full row actions plus
// drag-and-drop. Serial against the shared suite database; every title is
// unique to this spec and the created tasks are deleted at the end.
test.describe.configure({ mode: "serial" });

const ALPHA = "Merged page capture alpha";
const BETA = "Merged page capture beta";
const OVERSIZE = "Merged page oversized epic";
const STEP_ESTIMATED = "Merged page estimated step";
const STEP_OPEN = "Merged page unestimated step";

test("/capture redirects to the merged Tasks page; the nav entry is gone", async ({ page }) => {
  await page.goto("/capture");
  await page.waitForURL("**/tasks");
  await expect(captureForm(page).getByPlaceholder("What needs doing?")).toBeVisible();
  await expect(page.locator(".sidenav a", { hasText: "Capture" })).toHaveCount(0);
});

test("rapid entry: two captures back-to-back without re-clicking the title", async ({ page }) => {
  await page.goto("/tasks");
  const title = captureForm(page).getByPlaceholder("What needs doing?");
  // autoFocus puts the cursor in the title field on load…
  await expect(title).toBeFocused();
  // …so the whole capture is keyboard-only: type, Enter, keep typing.
  await page.keyboard.type(ALPHA);
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("");
  await expect(title).toBeFocused();
  await page.keyboard.type(BETA);
  await expect(title).toHaveValue(BETA);
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("");

  // Unestimated captures surface twice: as actionable needs-estimate triage
  // rows AND as ordinary rows in their category group below.
  await expect(triageStrip(page).getByText(ALPHA)).toBeVisible();
  await expect(triageStrip(page).getByText(BETA)).toBeVisible();
  await expect(taskTree(page).getByText(ALPHA)).toBeVisible();
});

test("estimating a needs-estimate row inline makes it leave the strip", async ({ page }) => {
  await page.goto("/tasks");
  const stripRow = triageStrip(page).getByText(ALPHA).locator("..");
  await stripRow.getByPlaceholder("min").fill("15");
  await stripRow.getByPlaceholder("min").press("Enter");

  // Ready needs no triage: only the tree row remains, wearing the estimate.
  await expect(triageStrip(page).getByText(ALPHA)).toHaveCount(0);
  await expect(
    taskTree(page).getByText(ALPHA).locator("..").locator(".chip", { hasText: "15 min" }),
  ).toBeVisible();
});

test("breaking down a too-big row from the strip yields subtasks; leftovers fold (#30)", async ({
  page,
}) => {
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill(OVERSIZE);
  await form.getByTitle("Effort estimate in minutes").fill("75");
  await form.getByRole("button", { name: "Add", exact: true }).click();

  // The too-big strip row offers Break down in place — the seam the merge
  // closed: the page that says "split them" owns the split control.
  const stripRow = triageStrip(page).getByText(OVERSIZE).locator("..");
  await stripRow.getByRole("button", { name: "Break down" }).click();
  const editor = subtaskEditor(page);
  await editor.getByPlaceholder("Small, concrete step…").nth(0).fill(STEP_ESTIMATED);
  await editor.getByPlaceholder("min").nth(0).fill("20");
  // The second step stays unestimated on purpose — it must re-surface as a
  // needs-estimate cluster folded under its parent (#30).
  await editor.getByPlaceholder("Small, concrete step…").nth(1).fill(STEP_OPEN);
  await editor.getByRole("button", { name: /Add 2 subtasks/ }).click();

  // The parent became a container: no longer a too-big row. Its unestimated
  // step clusters under the parent's collapsible header instead of flooding
  // the section flat.
  const cluster = triageStrip(page).locator("details").filter({ hasText: OVERSIZE });
  await expect(cluster.locator("summary")).toContainText("(1)");
  await expect(cluster.getByText(STEP_OPEN)).not.toBeVisible();
  await cluster.locator("summary").click();

  // The expanded sibling row carries the inline estimate input; resolving it
  // clears this spec's triage entirely.
  const stepRow = cluster.getByText(STEP_OPEN).locator("..");
  await stepRow.getByPlaceholder("min").fill("25");
  await stepRow.getByPlaceholder("min").press("Enter");
  await expect(triageStrip(page).getByText(STEP_OPEN)).toHaveCount(0);
  await expect(triageStrip(page).locator("details").filter({ hasText: OVERSIZE })).toHaveCount(0);

  // The tree shows the parent with both steps nested under it.
  await expect(taskTree(page).getByText(OVERSIZE)).toBeVisible();
  await expect(taskTree(page).getByText(STEP_ESTIMATED)).toBeVisible();
  await expect(taskTree(page).getByText(STEP_OPEN)).toBeVisible();
});

test("the category tree below the strip keeps drag-and-drop; strip rows have none", async ({
  page,
}) => {
  await page.goto("/tasks");
  // Strip rows render without the drag handle — the strip is a worklist,
  // not a second tree (rows outside the DnD context are not drop targets).
  await expect(taskTree(page).locator(".dnd-handle").first()).toBeVisible();
  await expect(triageStrip(page).locator(".dnd-handle")).toHaveCount(0);

  // Real pointer drag in the tree: BETA (still unestimated, so the strip
  // lists it too — tree scoping matters) nests under ALPHA, the same PATCH
  // as the #100 menu.
  const source = taskTree(page).getByText(BETA, { exact: true }).locator("..");
  const target = taskTree(page).getByText(ALPHA, { exact: true }).locator("..");
  await target.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const a = (await source.locator(".dnd-handle").boundingBox())!;
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  // No corrective re-measure hop here (#250): the reason strip is an absolute
  // overlay now, so mid-drag mounts shift nothing — the honest one-step drag
  // onto the PRE-drag box lands, and the highlight proves it.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(target).toHaveClass(/dnd-over/);
  await page.mouse.up();

  // The drop reparented: BETA re-renders as a subtask (promote affordance).
  await expect(
    taskTree(page).getByText(BETA, { exact: true }).locator("..").getByTitle("Promote to top-level"),
  ).toBeVisible();
  const tasks: { id: number; title: string; subtasks?: { title: string }[] }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  expect(tasks.find((t) => t.title === ALPHA)?.subtasks?.map((s) => s.title)).toContain(BETA);
});

// Leave no residue in the shared DB: ALPHA's 15/20/25-minute cards would
// otherwise join the deck later spec files draw from (warmup-draw asserts on
// the pool's smallest card). afterAll, not the tail of the last test: a
// failure ANYWHERE in this serial file must still clean up. `browser` is
// worker-scoped, so the hook runs even after mid-file failures; the fresh
// context inherits the config baseURL. Deletes cascade to subtasks.
test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const tasks: { id: number; title: string }[] = await (
    await ctx.request.get("/api/tasks")
  ).json();
  for (const title of [ALPHA, OVERSIZE]) {
    const t = tasks.find((x) => x.title === title);
    if (t) await ctx.request.delete(`/api/tasks/${t.id}`);
  }
  await ctx.close();
});
