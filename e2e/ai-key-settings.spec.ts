import { expect, test } from "@playwright/test";

// Runs alphabetically first (workers=1) against the shared E2E database.
// It must end with the key removed: the later journeys assume AI-degraded
// mode (playwright.config.ts sets ANTHROPIC_API_KEY to "").
test.describe.configure({ mode: "serial" });

const FAKE_KEY = "sk-ant-test-e2e-key-000000000000"; // never a real key

test("entering a key flips Settings to configured without a restart", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Not configured")).toBeVisible();

  const input = page.getByLabel("Claude API key");
  await input.fill(FAKE_KEY);
  await page.getByRole("button", { name: "Save key" }).click();

  await expect(page.getByText("✓ Claude API key configured")).toBeVisible();
  // Masked: the input clears on save and the key is never echoed back.
  await expect(input).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(FAKE_KEY);

  // Survives a reload — the status comes from the server, not client state.
  await page.reload();
  await expect(page.getByText("✓ Claude API key configured")).toBeVisible();
});

test("removing the key returns Settings to not-configured", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Remove key" }).click();

  await expect(page.getByText("Not configured")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove key" })).toHaveCount(0);
});
