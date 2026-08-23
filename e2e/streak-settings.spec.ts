import { expect, test } from "@playwright/test";

// Streak rest weekdays + freeze display (#58) — settings persistence only.
// Date-dependent streak scenarios (rest gaps, freeze consumption, milestones)
// live at unit/integration level where "today" is controllable.
test.describe("streak settings", () => {
  test("rest weekday toggles persist across a reload and the header stays honest", async ({
    page,
  }) => {
    await page.goto("/settings");
    const streakPanel = page.locator("section", { has: page.getByRole("heading", { name: "Streak" }) });
    const sat = streakPanel.getByRole("button", { name: "Sat", exact: true });
    const sun = streakPanel.getByRole("button", { name: "Sun", exact: true });

    await expect(sat).toHaveAttribute("aria-pressed", "false");
    await expect(sun).toHaveAttribute("aria-pressed", "false");

    await sat.click();
    await expect(sat).toHaveAttribute("aria-pressed", "true");
    await sun.click();
    await expect(sun).toHaveAttribute("aria-pressed", "true");

    // The freeze bank is displayed read-only right next to the toggles.
    await expect(streakPanel.getByText(/Freezes banked/)).toBeVisible();
    // Playwright specs share one throwaway suite database, so the earlier
    // real-production-RNG shop journey may persist a random Freeze pack bonus.
    const gamificationResponse = await page.request.get("/api/gamification");
    expect(gamificationResponse.ok()).toBe(true);
    const { freezesBanked, freezeBankCap } = await gamificationResponse.json();
    await expect(streakPanel.getByText(`🧊 ${freezesBanked}/${freezeBankCap}`)).toBeVisible();

    await page.reload();
    await expect(sat).toHaveAttribute("aria-pressed", "true");
    await expect(sun).toHaveAttribute("aria-pressed", "true");

    // The gamification header still renders with one of the four honest
    // flame states (which one depends on the real weekday and prior specs).
    await expect(page.locator("[data-flame]")).toBeVisible();

    // Leave the shared serial DB the way we found it.
    await sat.click();
    await expect(sat).toHaveAttribute("aria-pressed", "false");
    await sun.click();
    await expect(sun).toHaveAttribute("aria-pressed", "false");
  });
});
