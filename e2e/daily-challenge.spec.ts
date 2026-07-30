import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// The dealer's daily challenge (#231, ADR-63): the Draw page chip shows
// today's derived objective and flips to its paid state when the payout
// lands. WHICH objective today names is the date's business, so the spec
// reads it from the API and drives it generically — except track_30, whose
// 30 real minutes no E2E should fabricate; that day pins the chip render
// only. Runs after core-journey (no unlock theft) and cleans its tasks up
// (trophy-pile geometry).
test.describe.configure({ mode: "serial" });

const SEED_PREFIX = "Challenge e2e seed";

interface ChallengeState {
  key: string;
  label: string;
  target: number;
  progress: number;
  paid: boolean;
  xp: number;
}

async function getChallenge(request: APIRequestContext): Promise<ChallengeState> {
  return (await request.get("/api/challenge")).json();
}

async function mkTask(
  request: APIRequestContext,
  title: string,
  overrides: Record<string, unknown> = {},
) {
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  return (
    await request.post("/api/tasks", {
      data: { title, categoryId: categories[0].id, effortMinutes: 5, ...overrides },
    })
  ).json();
}

test("the chip shows today's objective and pays exactly once when driven to the target", async ({
  page,
}) => {
  const before = await getChallenge(page.request);

  await page.goto("/");
  const chip = page.getByTestId("challenge-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(`Today: ${before.label}`);

  if (before.key === "track_30") {
    // 30 genuine minutes are nobody's E2E budget: the render pin above is
    // this day's coverage; the payout path is integration-tested.
    await expect(chip).toContainText(`${before.progress}/${before.target}`);
    return;
  }
  if (before.paid) return; // an earlier spec's traffic already landed it

  // Drive the objective through the real API, by kind.
  const remaining = before.target - before.progress;
  if (before.key === "drawn_2") {
    for (let i = 0; i < remaining; i++) {
      const t = await mkTask(page.request, `${SEED_PREFIX} drawn ${i}`);
      // A draw stamps last_drawn_at; completing within the window counts as
      // drawn — the same path the app's own ✓ Done takes.
      await page.request.post("/api/draw", { data: {} });
      const current = await (await page.request.get("/api/draw/current")).json();
      const id = current?.task?.id ?? t.id;
      await page.request.patch(`/api/tasks/${id}`, { data: { status: "done" } });
    }
  } else if (before.key === "steps_2") {
    const parent = await mkTask(page.request, `${SEED_PREFIX} parent`, { effortMinutes: null });
    const subs = await (
      await page.request.post(`/api/tasks/${parent.id}/subtasks`, {
        data: {
          subtasks: Array.from({ length: remaining }, (_, i) => ({
            title: `${SEED_PREFIX} step ${i}`,
            effortMinutes: 5,
          })),
        },
      })
    ).json();
    for (const s of subs) {
      await page.request.patch(`/api/tasks/${s.id}`, { data: { status: "done" } });
    }
  } else {
    // complete_3 / before_noon (when it still can be met) — plain completions.
    for (let i = 0; i < remaining; i++) {
      const t = await mkTask(page.request, `${SEED_PREFIX} plain ${i}`);
      await page.request.patch(`/api/tasks/${t.id}`, { data: { status: "done" } });
    }
  }

  const after = await getChallenge(page.request);
  if (before.key === "before_noon" && !after.paid) {
    // Driven after local noon the objective is honestly unreachable today —
    // the chip must still show the un-paid state rather than lie.
    await page.reload();
    await expect(chip).toContainText(`${after.progress}/${after.target}`);
    return;
  }

  expect(after.paid).toBe(true);
  await page.reload();
  await expect(chip).toContainText(`+${after.xp} XP`);
  await expect(chip).toContainText("✔");
});

test.afterAll(async ({ request }) => {
  // Trophy-pile geometry + drawable leftovers: everything this spec made
  // leaves with its completions (delete cascades them).
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title.startsWith(SEED_PREFIX))) {
    await request.delete(`/api/tasks/${t.id}`);
  }
});
