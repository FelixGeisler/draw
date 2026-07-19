import { expect, test, type Page } from "@playwright/test";

// Goal resolution (#145): the victory overlay on the Goals page's own 🏁,
// the quiet ⌛ missed flow, and the Hall of Fame shelf. Runs against the
// shared suite database and only touches its own uniquely-named goals.
//
// Most tests emulate reduced motion (the suite's 6-spec precedent) so the
// assertions target dialog and shelf semantics, never animation timing —
// the last two tests pin the confetti gate itself: the canvas must appear
// for a real achieve and must NOT appear under reduced motion.
test.describe.configure({ mode: "serial" });

const WIN_TITLE = "Win the e2e championship";
const WIN_OUTCOME = "Grade 1.0 in the final";
const MISS_TITLE = "Read every e2e paper";

function goalHeading(page: Page) {
  return page.getByRole("heading", { name: `🎯 ${WIN_TITLE}` });
}

async function addGoal(page: Page, title: string, outcome?: string) {
  await page.getByPlaceholder(/^Goal — e\.g\./).fill(title);
  if (outcome) await page.getByPlaceholder(/How is success measured/).fill(outcome);
  await page.getByRole("button", { name: "Add goal" }).click();
  await expect(page.getByRole("heading", { name: `🎯 ${title}` })).toBeVisible();
}

function victoryDialog(page: Page) {
  return page.getByRole("dialog", { name: `Goal achieved: ${WIN_TITLE}` });
}

async function openShelf(page: Page) {
  await page.getByRole("button", { name: /Hall of Fame/ }).click();
}

async function reactivateFromShelf(page: Page, title: string) {
  await openShelf(page);
  await page
    .locator(".goal-trophy, .goal-missed-row")
    .filter({ hasText: title })
    .getByRole("button", { name: "↩ Reactivate" })
    .click();
  await expect(page.getByRole("heading", { name: `🎯 ${title}` })).toBeVisible();
}

test("achieving a goal opens the victory overlay; claiming it hangs the trophy", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/goals");
  await addGoal(page, WIN_TITLE, WIN_OUTCOME);

  await page
    .locator(".panel")
    .filter({ hasText: WIN_TITLE })
    .getByTitle("Mark achieved")
    .click();

  // The server-confirmed response opens the overlay with the goal's facts.
  const dialog = victoryDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: WIN_TITLE })).toBeVisible();
  await expect(dialog.getByText(WIN_OUTCOME)).toBeVisible();
  await expect(dialog.getByText("✓ 0/0 tasks")).toBeVisible();
  // resolved_at was stamped server-side and rides the response into the stats.
  await expect(dialog.getByText(/🗓 \d{1,2} \w{3} \d{4}/)).toBeVisible();

  await page.getByRole("button", { name: "Claim victory" }).click();
  await expect(dialog).not.toBeVisible();
  // Achieved goals leave the active list…
  await expect(goalHeading(page)).not.toBeVisible();

  // …and hang in the Hall of Fame with the resolution date.
  await openShelf(page);
  const trophy = page.locator(".goal-trophy").filter({ hasText: WIN_TITLE });
  await expect(trophy).toBeVisible();
  await expect(trophy.getByText(/Achieved \d{1,2} \w{3} \d{4}/)).toBeVisible();

  // Reactivate is the shelf's control (no Undo on the overlay): back to active.
  await trophy.getByRole("button", { name: "↩ Reactivate" }).click();
  await expect(goalHeading(page)).toBeVisible();
});

test("Escape dismisses the celebration like claiming it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/goals");

  await page
    .locator(".panel")
    .filter({ hasText: WIN_TITLE })
    .getByTitle("Mark achieved")
    .click();
  await expect(victoryDialog(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(victoryDialog(page)).not.toBeVisible();
  await expect(goalHeading(page)).not.toBeVisible();

  await reactivateFromShelf(page, WIN_TITLE);
});

test("marking missed is quiet: confirm, live-region line, subdued shelf row", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/goals");
  await addGoal(page, MISS_TITLE);

  page.on("dialog", (dialog) => dialog.accept());
  await page
    .locator(".panel")
    .filter({ hasText: MISS_TITLE })
    .getByTitle(/Mark missed/)
    .click();

  // No fanfare for a defeat: no overlay, just the status line as the row leaves.
  await expect(page.getByText(`Moved "${MISS_TITLE}" to the Hall of Fame as missed.`)).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: `🎯 ${MISS_TITLE}` })).not.toBeVisible();

  await openShelf(page);
  const row = page.locator(".goal-missed-row").filter({ hasText: MISS_TITLE });
  await expect(row).toBeVisible();
  await expect(row.getByText(/missed \d{1,2} \w{3} \d{4}/)).toBeVisible();
  await expect(row.getByText(/0\/0 tasks done/)).toBeVisible();

  // Reactivating clears the stale notice along with the row.
  await row.getByRole("button", { name: "↩ Reactivate" }).click();
  await expect(page.getByRole("heading", { name: `🎯 ${MISS_TITLE}` })).toBeVisible();
  await expect(page.getByText(/Moved .* to the Hall of Fame as missed/)).not.toBeVisible();
});

test("confetti fires for the page's own achieve", async ({ page }) => {
  // No reduced-motion emulation: this test pins that the celebration
  // actually happens. Presence of the confetti canvas only — no pixels.
  await page.goto("/goals");

  await page
    .locator(".panel")
    .filter({ hasText: WIN_TITLE })
    .getByTitle("Mark achieved")
    .click();
  await expect(victoryDialog(page)).toBeVisible();
  await expect(page.locator("body > canvas")).toHaveCount(1);

  await page.getByRole("button", { name: "Claim victory" }).click();
  await reactivateFromShelf(page, WIN_TITLE);
});

test("reduced motion suppresses the confetti entirely", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/goals");

  await page
    .locator(".panel")
    .filter({ hasText: WIN_TITLE })
    .getByTitle("Mark achieved")
    .click();
  await expect(victoryDialog(page)).toBeVisible();
  // The matchMedia gate skipped every burst: no canvas was ever created.
  await expect(page.locator("body > canvas")).toHaveCount(0);

  // Leave the goal achieved: the suite ends with a trophy on the shelf.
  await page.getByRole("button", { name: "Claim victory" }).click();
});

// Trophy cabinet redesign (#168): the case shows the committed cup art on a
// plaque, and missed goals sit in a quiet section BELOW the case — not inside
// it. Reduced-motion run: the assertions are structural, never animation.
test("the cabinet shows cup art + plaque, with missed goals below the case", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/goals");

  const CAB_WIN = "Fill the e2e trophy cabinet";
  const CAB_MISS = "Skip the e2e cabinet entry";

  // An achieved goal → a trophy standing in the case.
  await addGoal(page, CAB_WIN, "Ship the cabinet");
  await page.locator(".panel").filter({ hasText: CAB_WIN }).getByTitle("Mark achieved").click();
  await expect(page.getByRole("dialog", { name: `Goal achieved: ${CAB_WIN}` })).toBeVisible();
  await page.getByRole("button", { name: "Claim victory" }).click();

  // A missed goal → a quiet row beneath the case.
  await addGoal(page, CAB_MISS);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator(".panel").filter({ hasText: CAB_MISS }).getByTitle(/Mark missed/).click();
  await expect(page.getByText(`Moved "${CAB_MISS}" to the Hall of Fame as missed.`)).toBeVisible();

  await openShelf(page);

  // The trophy carries the committed cup image and a brass plaque with its facts.
  const trophy = page.locator(".goal-trophy").filter({ hasText: CAB_WIN });
  await expect(trophy).toBeVisible();
  await expect(trophy.locator("img.goal-trophy-cup")).toBeVisible();
  await expect(trophy.locator(".goal-trophy-plaque")).toContainText(CAB_WIN);
  await expect(trophy.getByText(/Achieved \d{1,2} \w{3} \d{4}/)).toBeVisible();

  // The missed row lives in the section below the case, never inside the cabinet.
  const missedRow = page.locator(".goal-missed-row").filter({ hasText: CAB_MISS });
  await expect(missedRow).toBeVisible();
  await expect(page.locator(".goal-cabinet .goal-missed-row")).toHaveCount(0);

  const caseBox = await page.locator(".goal-cabinet").boundingBox();
  const missedBox = await page.locator(".goal-missed").boundingBox();
  expect(caseBox).not.toBeNull();
  expect(missedBox).not.toBeNull();
  expect(missedBox!.y).toBeGreaterThanOrEqual(caseBox!.y + caseBox!.height - 4);

  // Reactivate works from the new trophy: back to the active list.
  await trophy.getByRole("button", { name: "↩ Reactivate" }).click();
  await expect(page.getByRole("heading", { name: `🎯 ${CAB_WIN}` })).toBeVisible();
});
