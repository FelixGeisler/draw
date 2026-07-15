import { expect, request as apiRequest, test } from "@playwright/test";

// Issue #61: Settings → Backup. Download the archive, mutate the data, then
// restore through the double-confirm flow and see the pre-backup state again.
// The restore replaces the ENTIRE shared E2E database with the snapshot taken
// inside this spec, so everything this spec changed after the download is
// rolled back — later specs seed their own data and are unaffected.
test.describe.configure({ mode: "serial" });

const KEEPSAKE = "Backup keepsake task";
const IMPOSTOR = "Post-backup impostor task";

// Backstop: the restore resurrects the keepsake, and later journey specs draw
// UNFILTERED from the shared pool — this spec's tasks must not linger in the
// deck they assert against. (afterAll cannot use the test-scoped fixtures.)
test.afterAll(async ({}, testInfo) => {
  const ctx = await apiRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  const tasks: { id: number; title: string }[] = await (await ctx.get("/api/tasks")).json();
  for (const t of tasks) {
    if (t.title === KEEPSAKE || t.title === IMPOSTOR) await ctx.delete(`/api/tasks/${t.id}`);
  }
  await ctx.dispose();
});

test("download backup, change data, double-confirm restore brings the old state back", async ({
  page,
}) => {
  // Seed a distinctive task that will only survive via the backup.
  const created = await page.request.post("/api/tasks", {
    data: { title: KEEPSAKE, categoryId: 1, effortMinutes: 10 },
  });
  expect(created.ok()).toBeTruthy();
  const keepsakeId = (await created.json()).id as number;

  // Download the backup from Settings.
  await page.goto("/settings");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download backup" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^draw-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipPath = await download.path();

  // Mutate: the keepsake disappears, an impostor appears.
  const del = await page.request.delete(`/api/tasks/${keepsakeId}`);
  expect(del.ok()).toBeTruthy();
  const impostor = await page.request.post("/api/tasks", {
    data: { title: IMPOSTOR, categoryId: 1, effortMinutes: 10 },
  });
  expect(impostor.ok()).toBeTruthy();

  await page.goto("/tasks");
  await expect(page.getByText(IMPOSTOR, { exact: true })).toBeVisible();
  await expect(page.getByText(KEEPSAKE, { exact: true })).toHaveCount(0);

  // Restore: pick the file, pass BOTH confirmation gates.
  await page.goto("/settings");
  await page.getByLabel("Backup archive").setInputFiles(zipPath);
  await page.getByRole("button", { name: "Restore from backup" }).click();

  await expect(page.getByText("Restoring replaces ALL current data.")).toBeVisible();
  const replaceButton = page.getByRole("button", { name: "Replace everything" });
  await expect(replaceButton).toBeDisabled(); // gate 2: nothing typed yet
  await page.getByLabel("Type REPLACE to confirm").fill("replace");
  await expect(replaceButton).toBeDisabled(); // exact word required
  await page.getByLabel("Type REPLACE to confirm").fill("REPLACE");
  await replaceButton.click();

  await expect(page.getByText(/✓ Backup restored/)).toBeVisible();

  // The pre-backup state is live again.
  await page.goto("/tasks");
  await expect(page.getByText(KEEPSAKE, { exact: true })).toBeVisible();
  await expect(page.getByText(IMPOSTOR, { exact: true })).toHaveCount(0);
});
