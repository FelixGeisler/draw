import { expect, test } from "@playwright/test";

// Outbound notifications (#235, ADR-67): the Settings surface. Delivery
// payloads are integration-tested against a mocked fetch; this pins the UI
// contract — configure (write-only), test button reports, remove turns it
// off. The test URL points at a closed loopback port so the awaited test
// send answers fast and deterministically without any network.
test.describe.configure({ mode: "serial" });

test("configure, test, and remove the webhook URL", async ({ page }) => {
  await page.goto("/settings");
  const status = page.getByTestId("notify-status");
  await expect(status).toContainText("No webhook configured");

  // Write-only save: the field clears, the flag flips.
  await page.getByTestId("notify-url-input").fill("http://127.0.0.1:9/draw-e2e");
  await page.getByTestId("notify-save").click();
  await expect(status).toContainText("Webhook configured");
  await expect(page.getByTestId("notify-url-input")).toHaveValue("");

  // The URL never leaks back through the public settings payload.
  const settings = await (await page.request.get("/api/settings")).json();
  expect(JSON.stringify(settings)).not.toContain("draw-e2e");

  // The test button is the one AWAITED send — port 9 refuses instantly, and
  // the honest failure line proves the round trip happened.
  await page.getByTestId("notify-test").click();
  await expect(page.getByTestId("notify-test-result")).toContainText("Failed");

  // Remove turns it off — later specs' completions must fire zero webhooks.
  await page.getByTestId("notify-remove").click();
  await expect(status).toContainText("No webhook configured");
});
