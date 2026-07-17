import { expect, request as apiRequest, test, type Page } from "@playwright/test";

// The Assistant page (#31, ADR-37). The agent LOOP is stubbed at the browser
// boundary with page.route() — the suite never mocks the SDK server-side and
// the E2E server has no key — but the APPLY is real: the reviewed operations
// hit the actual /api/ai/agent/apply transaction and the created tasks are
// asserted on the Tasks page. That split is exactly the feature's design:
// the loop proposes, the apply writes.
test.describe.configure({ mode: "serial" });

const FAKE_KEY = "sk-ant-test-e2e-assistant-000000"; // never a real key

// Backstop: later journey specs assume AI-degraded mode — the key must not
// survive this file even when a test fails mid-suite.
test.afterAll(async ({}, testInfo) => {
  const ctx = await apiRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
  await ctx.delete("/api/ai/key");
  await ctx.dispose();
});

const CHANGESET = {
  ops: [
    {
      kind: "create_task",
      draftId: "draft-1",
      task: { title: "E2E assistant umbrella", categoryId: 1 },
    },
    {
      kind: "create_subtasks",
      draftId: "draft-2",
      parentId: "draft-1",
      subtasks: [
        { draftId: "draft-3", title: "E2E solve exercise 1", effortMinutes: 20, impact: 3 },
        { draftId: "draft-4", title: "E2E solve exercise 2", effortMinutes: 25, impact: 4 },
      ],
    },
  ],
};

const USAGE = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  estimatedUsd: 0.015,
};

async function stubAgentLoop(page: Page) {
  await page.route("**/api/ai/agent/estimate", (route) =>
    route.fulfill({ json: { inputTokens: 1200, estimatedUsd: 0.006 } }),
  );
  await page.route("**/api/ai/agent/message", (route) =>
    route.fulfill({
      json: {
        sessionId: "e2e-session",
        reply: "I staged an umbrella task with two exercise subtasks for your review.",
        changeset: CHANGESET,
        usage: USAGE,
      },
    }),
  );
}

test("degraded mode hides the Assistant from the nav; a direct visit hints at Settings", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".sidenav")).toContainText("Draw");
  await expect(page.locator(".sidenav a", { hasText: "Assistant" })).toHaveCount(0);

  await page.goto("/assistant");
  await expect(page.getByText(/add your API key in Settings/)).toBeVisible();
});

test("ask → review changeset → apply → tasks visible on the Tasks page", async ({
  page,
  request,
}) => {
  // A (fake) key makes the server configured: the nav entry appears and the
  // REAL apply endpoint accepts. The loop itself never runs — it is stubbed.
  await request.put("/api/ai/key", { data: { key: FAKE_KEY } });
  await stubAgentLoop(page);

  await page.goto("/assistant");
  await expect(page.locator(".sidenav a", { hasText: "Assistant" })).toBeVisible();

  // Ask — the first send is estimate-gated.
  await page.getByTitle("Message to the assistant").fill("Import my mock exam as tasks");
  await page.getByRole("button", { name: "Estimate & send" }).click();
  await expect(page.getByText(/1,200 input tokens/)).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The reply and its cost line (output tokens priced in) render.
  await expect(page.getByText(/staged an umbrella task/)).toBeVisible();
  await expect(page.getByText(/340 out/)).toBeVisible();

  // Review: three staged rows — edit one title, deselect another.
  await expect(page.getByText("Staged changes — review before anything is written")).toBeVisible();
  await expect(page.getByTitle("Title draft-1")).toHaveValue("E2E assistant umbrella");
  await page.getByTitle("Title draft-3").fill("E2E prove the mean value theorem");
  await page.locator('input[title="Include draft-4"]').uncheck();

  // Apply is REAL: 1 parent + 1 included subtask = 2 changes.
  await page.getByRole("button", { name: "Apply 2 changes" }).click();
  await expect(page.getByText(/Applied — 2 tasks created/)).toBeVisible();

  // The created tasks are live on the Tasks page; the deselected row is not.
  await page.goto("/tasks");
  await expect(page.getByText("E2E assistant umbrella")).toBeVisible();
  await expect(page.getByText("E2E prove the mean value theorem")).toBeVisible();
  await expect(page.getByText("E2E solve exercise 2")).toHaveCount(0);
});

test("deselecting the draft parent deselects its staged subtasks", async ({ page, request }) => {
  await request.put("/api/ai/key", { data: { key: FAKE_KEY } });
  await stubAgentLoop(page);

  await page.goto("/assistant");
  await page.getByTitle("Message to the assistant").fill("Import my mock exam as tasks");
  await page.getByRole("button", { name: "Estimate & send" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Staged changes — review before anything is written")).toBeVisible();

  await page.locator('input[title="Include draft-1"]').uncheck();
  // The subtasks cascade off with their parent; nothing is left to apply.
  await expect(page.locator('input[title="Include draft-3"]')).not.toBeChecked();
  await expect(page.locator('input[title="Include draft-4"]')).not.toBeChecked();
  await expect(page.getByRole("button", { name: /^Apply/ })).toBeDisabled();

  // Cleanup for the shared DB: remove this spec's applied tasks and the key.
  const tasks = await (await request.get("/api/tasks?status=all")).json();
  const parent = tasks.find((t: { title: string }) => t.title === "E2E assistant umbrella");
  if (parent) await request.delete(`/api/tasks/${parent.id}`);
  await request.delete("/api/ai/key");
});
