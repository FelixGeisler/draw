import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { captureForm, taskTree } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const PREFIX = "Task calendar e2e";
const OVERDUE = `${PREFIX} overdue`;
const ALPHA = `${PREFIX} alpha`;
const BETA = `${PREFIX} beta`;
const BLOCKED = `${PREFIX} blocked`;
const RECURRING = `${PREFIX} recurring`;
const OTHER_SCOPE = `${PREFIX} other scope`;
const DONE = `${PREFIX} done`;
const UNDATED = `${PREFIX} undated`;
const PARENT = `${PREFIX} parent`;
const STEP = `${PREFIX} step`;

const createdIds: number[] = [];
let primaryCategory: { id: number; name: string; color: string };
let otherCategory: { id: number; name: string; color: string };
let recurringId: number;

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayFromToday(delta: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return localDay(date);
}

const TODAY = dayFromToday(0);
const OVERDUE_DAY = dayFromToday(-3);

async function createTask(
  request: APIRequestContext,
  data: Record<string, unknown>,
) {
  const response = await request.post("/api/tasks", { data });
  if (!response.ok())
    throw new Error(
      `create task failed (${response.status()}): ${await response.text()}`,
    );
  const task = await response.json();
  createdIds.push(task.id);
  return task;
}

function calendar(page: Page) {
  return page.getByTestId("task-calendar");
}

async function openCalendar(page: Page) {
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(calendar(page)).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  const categories = await (await request.get("/api/categories")).json();
  if (categories.length < 2)
    throw new Error("task calendar spec needs at least two categories");
  [primaryCategory, otherCategory] = categories;

  await createTask(request, {
    title: OVERDUE,
    categoryId: primaryCategory.id,
    dueDate: OVERDUE_DAY,
    effortMinutes: 10,
  });
  await createTask(request, {
    title: BETA,
    categoryId: primaryCategory.id,
    dueDate: TODAY,
    effortMinutes: 15,
  });
  await createTask(request, {
    title: ALPHA,
    categoryId: primaryCategory.id,
    dueDate: TODAY,
  });
  const blocked = await createTask(request, {
    title: BLOCKED,
    categoryId: primaryCategory.id,
    dueDate: TODAY,
    effortMinutes: 20,
  });
  await request.patch(`/api/tasks/${blocked.id}`, { data: { blocked: true } });
  const recurring = await createTask(request, {
    title: RECURRING,
    categoryId: primaryCategory.id,
    dueDate: TODAY,
    recurEveryDays: 7,
    effortMinutes: 10,
  });
  recurringId = recurring.id;
  await createTask(request, {
    title: OTHER_SCOPE,
    categoryId: otherCategory.id,
    dueDate: TODAY,
    effortMinutes: 10,
  });
  const done = await createTask(request, {
    title: DONE,
    categoryId: primaryCategory.id,
    dueDate: TODAY,
  });
  await request.patch(`/api/tasks/${done.id}`, { data: { status: "done" } });
  await createTask(request, {
    title: UNDATED,
    categoryId: primaryCategory.id,
  });
  const parent = await createTask(request, {
    title: PARENT,
    categoryId: primaryCategory.id,
  });
  const stepsResponse = await request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: {
      subtasks: [{ title: STEP, effortMinutes: 5 }],
      orderMode: "sequential",
    },
  });
  if (!stepsResponse.ok())
    throw new Error(`create subtask failed (${stepsResponse.status()})`);
  const [step] = await stepsResponse.json();
  await request.patch(`/api/tasks/${step.id}`, { data: { dueDate: TODAY } });
});

test("desktop calendar toggles, navigates, orders overdue work, edits, and follows work mode", async ({
  page,
}) => {
  await page.goto("/tasks");
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("show done").check();
  await openCalendar(page);

  // Calendar replaces only the list surfaces. Quick capture remains mounted,
  // while the List-only setting retains its session value out of sight.
  await expect(captureForm(page)).toBeVisible();
  await expect(taskTree(page)).toHaveCount(0);
  await expect(page.getByLabel("show done")).toHaveCount(0);

  const overdue = calendar(page).getByRole("heading", {
    name: /Overdue \(\d+\)/,
  });
  await expect(overdue).toBeVisible();
  const overdueSection = calendar(page).locator(".task-calendar-overdue");
  await expect(
    overdueSection.getByText(OVERDUE, { exact: true }),
  ).toBeVisible();
  await expect(overdueSection.getByText(ALPHA, { exact: true })).toHaveCount(0); // today is not overdue

  const todayCell = calendar(page).locator(`[data-calendar-date="${TODAY}"]`);
  await expect(todayCell).toHaveClass(/today/);
  for (const title of [ALPHA, BETA, BLOCKED, RECURRING, OTHER_SCOPE, STEP]) {
    await expect(todayCell.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(todayCell.getByText(DONE, { exact: true })).toHaveCount(0);
  await expect(calendar(page).getByText(UNDATED, { exact: true })).toHaveCount(
    0,
  );

  const orderedTitles = await todayCell
    .locator(".task-calendar-title")
    .allTextContents();
  expect(orderedTitles).toEqual(
    [...orderedTitles].sort((a, b) => a.localeCompare(b)),
  );
  const alphaButton = todayCell.locator(".task-calendar-item", {
    hasText: ALPHA,
  });
  await expect(
    alphaButton.getByText(primaryCategory.name, { exact: true }),
  ).toBeVisible();
  await expect(alphaButton.locator(".task-calendar-dot")).toHaveCSS(
    "background-color",
    primaryCategory.color.startsWith("#")
      ? hexToRgb(primaryCategory.color)
      : primaryCategory.color,
  );

  // Switching back restores the List-only value without persisting anything.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByLabel("show done")).toBeChecked();
  await openCalendar(page);

  // Month navigation is transient and Today returns without a reload.
  await calendar(page).getByRole("button", { name: "Next month" }).click();
  await expect(
    calendar(page).getByText("No tasks due this month.", { exact: true }),
  ).toBeVisible();
  await calendar(page)
    .getByRole("button", { name: "Today", exact: true })
    .click();
  await expect(
    calendar(page).locator(`[data-calendar-date="${TODAY}"]`),
  ).toHaveClass(/today/);

  // Overdue remains on its truthful original day when that month is selected.
  const overdueIsInEarlierMonth = OVERDUE_DAY.slice(0, 7) !== TODAY.slice(0, 7);
  if (overdueIsInEarlierMonth) {
    await calendar(page)
      .getByRole("button", { name: "Previous month" })
      .click();
  }
  await expect(
    calendar(page)
      .locator(`[data-calendar-date="${OVERDUE_DAY}"]`)
      .getByText(OVERDUE, { exact: true }),
  ).toBeVisible();
  if (overdueIsInEarlierMonth) {
    await calendar(page)
      .getByRole("button", { name: "Today", exact: true })
      .click();
  }

  // Native task buttons provide pointer and keyboard activation of TaskForm.
  await alphaButton.focus();
  await page.keyboard.press("Enter");
  const editor = calendar(page).getByRole("region", { name: `Edit ${ALPHA}` });
  await expect(editor.getByPlaceholder("What needs doing?")).toBeFocused();
  await editor.getByTitle("Due date (optional)").fill(dayFromToday(1));
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  const alphaAfterCancel = await (
    await page.request.get("/api/tasks?status=all")
  ).json();
  expect(findTask(alphaAfterCancel, ALPHA)?.dueDate).toBe(TODAY);

  const targetDay = sameMonthEditDay();
  await todayCell.locator(".task-calendar-item", { hasText: ALPHA }).click();
  const saveEditor = calendar(page).getByRole("region", {
    name: `Edit ${ALPHA}`,
  });
  await saveEditor.getByTitle("Due date (optional)").fill(targetDay);
  await saveEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    calendar(page)
      .locator(`[data-calendar-date="${targetDay}"]`)
      .getByText(ALPHA, { exact: true }),
  ).toBeVisible();
  await expect(todayCell.getByText(ALPHA, { exact: true })).toHaveCount(0);

  // One API recurrence completion advances the same item. Calendar renders
  // only that new payload date, never a synthesized series.
  const completion = await page.request.patch(`/api/tasks/${recurringId}`, {
    data: { status: "done" },
  });
  expect(completion.ok()).toBe(true);
  const completionBody = await completion.json();
  const advancedDay: string = completionBody.task.dueDate;
  await page.reload();
  await openCalendar(page);
  if (advancedDay.slice(0, 7) !== TODAY.slice(0, 7)) {
    await calendar(page).getByRole("button", { name: "Next month" }).click();
  }
  await expect(
    calendar(page)
      .locator(`[data-calendar-date="${advancedDay}"]`)
      .getByText(RECURRING, { exact: true }),
  ).toHaveCount(1);

  // Apply work mode through the existing category convention, then clear it
  // from Tasks and watch the same calendar payload widen immediately.
  await page.goto("/");
  await page
    .locator(".draw-filters .chip", { hasText: primaryCategory.name })
    .click();
  await page.goto("/tasks");
  await openCalendar(page);
  await expect(
    calendar(page).getByText(OTHER_SCOPE, { exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("deck-scope-bar").getByRole("button").click();
  await expect(
    calendar(page)
      .locator(".task-month-grid")
      .getByText(OTHER_SCOPE, { exact: true }),
  ).toBeVisible();
});

test("dated steps under undated sequential parents keep recurrence hidden", async ({
  page,
}) => {
  await page.goto("/tasks");
  await openCalendar(page);

  const stepButton = calendar(page)
    .locator(`[data-calendar-date="${TODAY}"]`)
    .locator(".task-calendar-item", { hasText: STEP });
  await stepButton.click();

  const editor = calendar(page).getByRole("region", { name: `Edit ${STEP}` });
  await expect(editor.getByTitle("Repeat every N days (optional)")).toHaveCount(0);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("phone uses an ordered agenda and never widens the document", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks");
  await openCalendar(page);

  await expect(calendar(page).locator(".task-month-grid")).toBeHidden();
  await expect(calendar(page).locator(".task-month-agenda")).toBeVisible();
  await expect(calendar(page).locator(".task-calendar-overdue")).toBeVisible();

  const todayAgenda = calendar(page).locator(`[data-agenda-date="${TODAY}"]`);
  await expect(todayAgenda).toBeVisible();
  const titles = await todayAgenda
    .locator(".task-calendar-title")
    .allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  await expect(todayAgenda.getByText(STEP, { exact: true })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
});

test.afterAll(async ({ request }) => {
  for (const id of [...createdIds].reverse()) {
    const response = await request.delete(`/api/tasks/${id}`);
    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `cleanup: delete task ${id} failed (${response.status()})`,
      );
    }
  }
});

function findTask(roots: any[], title: string): any | undefined {
  for (const root of roots) {
    if (root.title === title) return root;
    const subtask = root.subtasks?.find((task: any) => task.title === title);
    if (subtask) return subtask;
  }
}

function sameMonthEditDay(): string {
  const today = new Date(`${TODAY}T12:00:00`);
  const candidate = new Date(today);
  candidate.setDate(today.getDate() + 1);
  if (candidate.getMonth() !== today.getMonth())
    candidate.setDate(today.getDate() - 1);
  return localDay(candidate);
}

function hexToRgb(hex: string): string {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((part) => part + part)
          .join("")
      : value;
  return `rgb(${Number.parseInt(full.slice(0, 2), 16)}, ${Number.parseInt(full.slice(2, 4), 16)}, ${Number.parseInt(full.slice(4, 6), 16)})`;
}
