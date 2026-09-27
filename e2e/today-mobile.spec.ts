import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["Pixel 7"], timezoneId: "UTC" });

test("Today stays within the phone viewport, keeps 44px targets, and is absent from bottom navigation", async ({ page }) => {
  await page.route("**/api/push/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      available: false,
      reason: "not-production",
      mutationAllowed: false,
      mutationReason: "secure-transport-required",
      vapidPublicKey: null,
      maxDevices: 16,
      preferences: { hideDetails: false, leadDays: 1, sendTime: "09:00", timezone: "UTC", quietStart: null, quietEnd: null },
      devices: [],
    }),
  }));
  await page.route("**/api/daily-overview?*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      timezone: "UTC",
      localDate: "2026-09-27",
      counts: { overdue: 1, today: 1, tomorrow: 0 },
      groups: {
        overdue: [{ type: "task", id: 71, title: "A long overdue task title that must wrap without widening the document", date: "2026-09-20" }],
        today: [{ type: "goal", id: 72, title: "Phone goal", date: "2026-09-27" }],
        tomorrow: [],
      },
    }),
  }));

  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const nav = page.locator(".sidenav");
  await expect(nav.getByRole("link", { name: "Today", exact: true })).toHaveCount(0);
  await expect(page.locator(".sidenav .brand")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  for (const target of await page.locator(".today-page a, .today-page button, .today-page input").all()) {
    if (!(await target.isVisible())) continue;
    const box = await target.boundingBox();
    expect(box, "visible interactive target has a box").not.toBeNull();
    expect(box!.height, await target.getAttribute("aria-label") ?? await target.textContent() ?? "target").toBeGreaterThanOrEqual(44);
  }
});
