import { expect, test, type Locator, type Page } from "@playwright/test";
import { captureForm, drawFromGoal, taskTree } from "./helpers.js";
import {
  namedZoneBoundaryFailures,
  validUtcBoundarySlots,
} from "../server/test/fixedSlotVectors.js";

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "Europe/Berlin" });

const TITLE = "E2E fixed <script>alert(1)</script> appointment";
const DRAW_TITLE = "E2E reveal then schedule fixed";
const GOAL_TITLE = "E2E fixed-slot draw scope";
let taskId: number;
let drawTaskId: number;
let viewerZoneTaskId: number;
let boundaryTaskId: number;
let goalId: number;

function row(page: Page, title: string): Locator {
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}

async function installClock(page: Page) {
  await page.clock.install({ time: new Date("2026-10-20T08:00:00.000Z") });
}

test("desktop form creates a strict fixed slot, preserves deadline, and renders hostile title as text", async ({ page }) => {
  await installClock(page);
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill(TITLE);
  await form.getByTitle("Effort estimate in minutes").fill("15");
  await form.getByTitle("Due date (optional)").fill("2026-12-24");
  await form.getByRole("button", { name: "Add fixed time" }).click();
  await form.getByLabel("Fixed start").fill("2026-10-25T02:30");
  await form.getByLabel("Fixed end").fill("2026-10-25T03:30");
  await form.getByLabel("Entry timezone").selectOption("Europe/Berlin");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByPlaceholder("What needs doing?")).toHaveValue("");

  const taskRow = row(page, TITLE);
  await expect(taskRow).toBeVisible();
  await expect(taskRow.locator("script")).toHaveCount(0);
  await expect(taskRow.getByText(/fixed 2026-10-25T02:30/)).toBeVisible();
  await expect(taskRow.getByText("due 2026-12-24")).toBeVisible();

  const tasks = await (await page.request.get("/api/tasks")).json();
  const task = tasks.find((candidate: { title: string }) => candidate.title === TITLE);
  taskId = task.id;
  expect(task).toMatchObject({
    dueDate: "2026-12-24",
    hasFixedSlot: true,
    fixedSlot: {
      startLocal: "2026-10-25T02:30",
      endLocal: "2026-10-25T03:30",
      entryTimezone: "Europe/Berlin",
      startsAt: "2026-10-25T00:30:00.000Z",
      endsAt: "2026-10-25T02:30:00.000Z",
      startOffsetSeconds: 7200,
      endOffsetSeconds: 3600,
    },
  });
});

test("UI carries UTC year controls and rejects named-zone underflow/overflow without a partial save", async ({ page }) => {
  await installClock(page);
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill("E2E UTC boundary control");
  await form.getByTitle("Effort estimate in minutes").fill("10");
  await form.getByRole("button", { name: "Add fixed time" }).click();
  await form.getByLabel("Fixed start").fill(validUtcBoundarySlots[0].slot.startLocal);
  await form.getByLabel("Fixed end").fill(validUtcBoundarySlots[0].slot.endLocal);
  await form.getByLabel("Entry timezone").selectOption("UTC");
  await form.getByRole("button", { name: "Add", exact: true }).click();

  let stored = (await (await page.request.get("/api/tasks")).json()).find(
    (candidate: { title: string }) => candidate.title === "E2E UTC boundary control",
  );
  boundaryTaskId = stored.id;
  expect(stored.fixedSlot).toMatchObject({
    startsAt: validUtcBoundarySlots[0].startsAt,
    endsAt: validUtcBoundarySlots[0].endsAt,
  });

  await row(page, "E2E UTC boundary control").getByTitle("Edit", { exact: true }).click();
  let editor = taskTree(page);
  await editor.getByLabel("Fixed start").fill(validUtcBoundarySlots[1].slot.startLocal);
  await editor.getByLabel("Fixed end").fill(validUtcBoundarySlots[1].slot.endLocal);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  stored = (await (await page.request.get("/api/tasks")).json()).find(
    (candidate: { id: number }) => candidate.id === boundaryTaskId,
  );
  expect(stored.fixedSlot).toMatchObject({
    startsAt: validUtcBoundarySlots[1].startsAt,
    endsAt: validUtcBoundarySlots[1].endsAt,
  });

  for (const vector of namedZoneBoundaryFailures) {
    await row(page, "E2E UTC boundary control").getByTitle("Edit", { exact: true }).click();
    editor = taskTree(page);
    await editor.getByLabel("Fixed start").fill(vector.slot.startLocal);
    await editor.getByLabel("Fixed end").fill(vector.slot.endLocal);
    await editor.getByLabel("Entry timezone").selectOption(vector.slot.entryTimezone);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("outside supported UTC years");
    await editor.getByRole("button", { name: "Cancel" }).click();
  }
  stored = (await (await page.request.get("/api/tasks")).json()).find(
    (candidate: { id: number }) => candidate.id === boundaryTaskId,
  );
  expect(stored.fixedSlot).toMatchObject({ startsAt: validUtcBoundarySlots[1].startsAt });
});

test("a changed viewer zone cannot float stored instants; only an explicit slot edit can", async ({ browser, page }) => {
  await installClock(page);
  const category = (await (await page.request.get("/api/categories")).json())[0];
  const created = await (
    await page.request.post("/api/tasks", {
      data: {
        title: "E2E viewer-zone stable slot",
        categoryId: category.id,
        effortMinutes: 10,
        fixedSlot: {
          startLocal: "2026-10-25T02:30",
          endLocal: "2026-10-25T03:30",
          entryTimezone: "Europe/Berlin",
        },
      },
    })
  ).json();
  viewerZoneTaskId = created.id;
  const original = {
    startsAt: created.fixedSlot.startsAt,
    endsAt: created.fixedSlot.endsAt,
  };

  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL as string,
    timezoneId: "America/New_York",
  });
  try {
    const changedViewer = await context.newPage();
    await installClock(changedViewer);
    await changedViewer.goto("/tasks");
    await row(changedViewer, "E2E viewer-zone stable slot").getByTitle("Edit", { exact: true }).click();
    const editor = taskTree(changedViewer);
    await expect(editor.getByLabel("Entry timezone")).toHaveValue("Europe/Berlin");
    await expect(editor.getByLabel("Fixed start")).toHaveValue("2026-10-25T02:30");
    await expect(editor.getByLabel("Fixed end")).toHaveValue("2026-10-25T03:30");

    let stored = (await (await changedViewer.request.get("/api/tasks")).json()).find(
      (candidate: { id: number }) => candidate.id === viewerZoneTaskId,
    );
    expect(stored.fixedSlot).toMatchObject(original);

    await editor.getByLabel("Fixed start").fill("2026-10-25T03:30");
    await editor.getByLabel("Fixed end").fill("2026-10-25T04:30");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    stored = (await (await changedViewer.request.get("/api/tasks")).json()).find(
      (candidate: { id: number }) => candidate.id === viewerZoneTaskId,
    );
    expect(stored.fixedSlot.startsAt).not.toBe(original.startsAt);
    expect(stored.fixedSlot.entryTimezone).toBe("Europe/Berlin");
  } finally {
    await context.close();
  }
});

test("form keeps gap errors inline and edits in the stored entry zone", async ({ page }) => {
  await installClock(page);
  await page.goto("/tasks");
  await row(page, TITLE).getByTitle("Edit", { exact: true }).click();
  const editor = taskTree(page);
  await expect(editor.getByLabel("Entry timezone")).toHaveValue("Europe/Berlin");
  await expect(editor.getByLabel("Fixed start")).toHaveValue("2026-10-25T02:30");
  await editor.getByLabel("Fixed start").fill("2026-03-29T02:30");
  await editor.getByLabel("Fixed end").fill("2026-03-29T03:30");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("nonexistent wall minute");
  await expect(editor.getByPlaceholder("What needs doing?")).toHaveValue(TITLE);

  await editor.getByLabel("Fixed start").fill("2026-11-01T01:30");
  await editor.getByLabel("Fixed end").fill("2026-11-01T02:30");
  await editor.getByLabel("Entry timezone").selectOption("America/New_York");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByPlaceholder("What needs doing?")).not.toBeVisible();
  const task = (await (await page.request.get("/api/tasks")).json()).find(
    (candidate: { id: number }) => candidate.id === taskId,
  );
  expect(task).toMatchObject({
    dueDate: "2026-12-24",
    fixedSlot: {
      startLocal: "2026-11-01T01:30",
      entryTimezone: "America/New_York",
      startsAt: "2026-11-01T05:30:00.000Z",
    },
  });
});

test("narrow keyboard path removes the slot without overflow", async ({ page }) => {
  await installClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks");
  await row(page, TITLE).getByTitle("Edit", { exact: true }).click();
  const editor = taskTree(page);
  const fixedEditor = editor.getByRole("group", { name: "Fixed time" });
  await expect(fixedEditor).toBeVisible();
  await expect(editor.getByLabel("Fixed start")).toBeVisible();
  await expect(editor.getByLabel("Fixed end")).toBeVisible();
  await expect(editor.getByLabel("Entry timezone")).toBeVisible();
  expect(
    await fixedEditor.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && el.scrollWidth <= el.clientWidth;
    }),
  ).toBe(true);
  const tabTo = async (label: string) => {
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate((expected) => document.activeElement?.getAttribute("aria-label") === expected, label)) return;
    }
    throw new Error(`keyboard focus did not reach ${label}`);
  };
  await editor.getByLabel("Fixed start").focus();
  await expect(editor.getByLabel("Fixed start")).toBeFocused();
  await tabTo("Fixed end");
  await expect(editor.getByLabel("Fixed end")).toBeFocused();
  await tabTo("Entry timezone");
  await expect(editor.getByLabel("Entry timezone")).toBeFocused();

  const remove = editor.getByRole("button", { name: "Remove fixed time" });
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(taskTree(page).getByLabel("Fixed start")).not.toBeVisible();
  const save = taskTree(page).getByRole("button", { name: "Save", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(taskTree(page).getByPlaceholder("What needs doing?")).not.toBeVisible();
  await expect(row(page, TITLE)).toBeVisible();
  expect(
    await row(page, TITLE).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }),
  ).toBe(true);

  const task = (await (await page.request.get("/api/tasks")).json()).find(
    (candidate: { id: number }) => candidate.id === taskId,
  );
  expect(task).toMatchObject({ dueDate: "2026-12-24", hasFixedSlot: false, fixedSlot: null });
});

test("UI scheduling a revealed card clears it; reveal itself creates no slot or work session", async ({ page }) => {
  await installClock(page);
  const category = (await (await page.request.get("/api/categories")).json())[0];
  const goal = await (
    await page.request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  goalId = goal.id;
  const task = await (
    await page.request.post("/api/tasks", {
      data: { title: DRAW_TITLE, categoryId: category.id, goalId, effortMinutes: 10 },
    })
  ).json();
  drawTaskId = task.id;

  const timerBefore = await (await page.request.get("/api/timer/current")).json();
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.getByText(DRAW_TITLE, { exact: true })).toBeVisible();
  let listed = (await (await page.request.get(`/api/tasks?goalId=${goalId}`)).json())[0];
  expect(listed.fixedSlot).toBeNull();
  expect(await (await page.request.get("/api/timer/current")).json()).toEqual(timerBefore);

  await page.goto("/tasks");
  await row(page, DRAW_TITLE).getByTitle("Edit", { exact: true }).click();
  const editor = taskTree(page);
  const addFixed = editor.getByRole("button", { name: "Add fixed time" });
  await addFixed.focus();
  await page.keyboard.press("Enter");
  await editor.getByLabel("Fixed start").fill("2026-10-20T10:00");
  await editor.getByLabel("Fixed end").fill("2026-10-20T11:00");
  await editor.getByLabel("Entry timezone").selectOption("UTC");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  expect(await (await page.request.get("/api/draw/current")).json()).toBeNull();
  const pool = await (await page.request.get(`/api/draw/pool?goalId=${goalId}`)).json();
  expect(pool.candidates).toEqual([]);
  listed = (await (await page.request.get(`/api/tasks?goalId=${goalId}`)).json())[0];
  expect(listed.hasFixedSlot).toBe(true);
});

test.afterAll(async ({ request }) => {
  for (const id of [taskId, drawTaskId, viewerZoneTaskId, boundaryTaskId]) {
    if (id) await request.delete(`/api/tasks/${id}`);
  }
  if (goalId) await request.delete(`/api/goals/${goalId}`);
});
