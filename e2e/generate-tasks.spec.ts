import { expect, test, type Page, type Request } from "@playwright/test";
import { drawFromGoal, taskTree, triageStrip } from "./helpers";

// Issue #29: the generate-tasks review panel on the Goals page. AI responses
// are mocked at the browser boundary with page.route() — the suite never mocks
// the SDK server-side — so every task write below hits the real server. The
// suite's own server runs AI-degraded (no key), which the unmocked tests rely
// on.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "Import the e2e mock exam";
const MATERIAL_NAME = "mock-exam.txt";
const PARENT_TITLE = "Mock exam import";
const EDITED_LEAF_TITLE = "Prove the mean value theorem";

// 3 exercises, 30 pts, 20 + (30+30) + 25 = 105 min; exercise 2 (60 min) is
// split into 2 parts — the fixture mirrors a real /api/ai/generate-tasks
// response after server-side post-processing (#28).
const GENERATE_RESULT = {
  sourceOverview: "Mock exam with 3 exercises totaling 30 points.",
  oversizedParts: false,
  tasks: [
    {
      label: "1",
      title: "Solve exercise 1 (limits)",
      points: 8,
      statedMinutes: 20,
      estimatedMinutes: 20,
      suggestedImpact: 3,
      rationale: "Ex. 1, 8 pts, ~20 min per the PDF",
      parts: [],
      impact: 2,
      impactSource: "points",
    },
    {
      label: "2",
      title: "Solve exercise 2 (integrals)",
      points: 12,
      statedMinutes: 60,
      estimatedMinutes: 60,
      suggestedImpact: 4,
      rationale: "Ex. 2, 12 pts, ~60 min per the PDF",
      parts: [
        { title: "Solve exercise 2 (integrals) (part 1/2)", minutes: 30 },
        { title: "Solve exercise 2 (integrals) (part 2/2)", minutes: 30 },
      ],
      impact: 5,
      impactSource: "points",
    },
    {
      label: "3",
      title: "Prove theorem from exercise 3",
      points: 10,
      statedMinutes: null,
      estimatedMinutes: 25,
      suggestedImpact: 4,
      rationale: "Ex. 3, 10 pts per the PDF",
      parts: [],
      impact: 4,
      impactSource: "points",
    },
  ],
};

function card(page: Page, title: string) {
  return page.locator(".panel").filter({ hasText: title });
}

async function mockConfigured(page: Page) {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: { configured: true, model: "claude-opus-4-8", keySource: "database" },
    }),
  );
}

test("the generate button is absent while AI is not configured", async ({ page, request }) => {
  const goal = await (
    await request.post("/api/goals", {
      data: { title: GOAL_TITLE, outcome: "60% to pass", targetDate: "2027-01-01" },
    })
  ).json();
  await request.post(`/api/goals/${goal.id}/materials`, {
    multipart: {
      file: {
        name: MATERIAL_NAME,
        mimeType: "text/plain",
        buffer: Buffer.from("Exercise 1 (8 pts, 20 min) ... Exercise 3 (10 pts)"),
      },
    },
  });

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await expect(goalCard.getByRole("button", { name: "+ Add task" })).toBeVisible();
  await expect(goalCard.getByRole("button", { name: "✨ Generate tasks" })).not.toBeVisible();
  await expect(goalCard.getByRole("button", { name: "✨ Plan backward" })).not.toBeVisible();
});

test("generate → review → commit: nothing written before commit, then one parent + 4 leaves", async ({
  page,
}) => {
  await mockConfigured(page);
  await page.route("**/api/ai/estimate", (route) =>
    route.fulfill({ json: { inputTokens: 54321, estimatedUsd: 0.27 } }),
  );
  await page.route("**/api/ai/generate-tasks", (route) =>
    route.fulfill({ json: GENERATE_RESULT }),
  );

  // The acceptance criterion: no POST /api/tasks* during generate + review.
  const taskWrites: string[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.startsWith("/api/tasks")) {
      taskWrites.push(new URL(req.url()).pathname);
    }
  });

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await goalCard.getByRole("button", { name: "✨ Generate tasks" }).click();

  // Shared category plumbing with Plan backward.
  await expect(goalCard.getByTitle("Category for accepted tasks")).toBeVisible();

  await goalCard.getByText(`📄 ${MATERIAL_NAME}`).click(); // select the material
  const instruction = goalCard.getByTitle("What should Claude extract?");
  await instruction.fill("One task per exercise — points as impact, stated time as effort");

  // Estimate gate before the paid call, same contract as the other panels.
  await goalCard.getByRole("button", { name: "Estimate cost" }).click();
  await expect(goalCard.getByText(/54,321 input tokens/)).toBeVisible();
  await goalCard.getByRole("button", { name: "Ask Claude" }).click();

  // Summary header — the spot-check backstop against merged/skipped items.
  await expect(
    goalCard.getByText("3 exercises · 30 pts · ≈1h 45m · 1 split into parts"),
  ).toBeVisible();
  await expect(goalCard.getByText(GENERATE_RESULT.sourceOverview)).toBeVisible();
  // Rationale lines allow auditing each row against the material.
  await expect(goalCard.getByText("Ex. 1, 8 pts, ~20 min per the PDF")).toBeVisible();
  // Part rows are present as editable inputs under their exercise.
  await expect(goalCard.getByTitle("Part title").first()).toHaveValue(
    "Solve exercise 2 (integrals) (part 1/2)",
  );

  // Unchecking an exercise unchecks its parts (and shrinks the commit).
  const exercise2 = goalCard.getByTitle("Include exercise 2");
  await exercise2.uncheck();
  await expect(goalCard.getByTitle("Include part 1 of exercise 2")).not.toBeChecked();
  await expect(goalCard.getByTitle("Include part 2 of exercise 2")).not.toBeChecked();
  await expect(goalCard.getByRole("button", { name: "Add 2 tasks" })).toBeVisible();
  await exercise2.check();
  await expect(goalCard.getByTitle("Include part 1 of exercise 2")).toBeChecked();

  // Select none / select all round-trips on the whole list.
  await goalCard.getByRole("button", { name: "Select none" }).click();
  await expect(goalCard.getByRole("button", { name: "Add 0 tasks" })).toBeDisabled();
  await goalCard.getByRole("button", { name: "Select all" }).click();
  await expect(goalCard.getByRole("button", { name: "Add 4 tasks" })).toBeEnabled();

  // Edits: effort of exercise 1, title of exercise 3. Within the fixed
  // fixture the DOM order is ex1-minutes, part-minutes ×2, ex3-minutes; the
  // partless exercises own the two "Exercise title" inputs (ex2 renders its
  // title as static text).
  const ex1Minutes = goalCard.getByTitle("minutes").first();
  await expect(ex1Minutes).toHaveValue("20");
  await ex1Minutes.fill("15");
  const ex3Title = goalCard.getByTitle("Exercise title").nth(1);
  await expect(ex3Title).toHaveValue("Prove theorem from exercise 3");
  await ex3Title.fill(EDITED_LEAF_TITLE);

  // Impact is editable at review now (#161, ADR-14): correct exercise 1 from
  // its point-derived 2 up to 5 — the value must land on the committed leaf.
  await goalCard
    .getByTitle("Impact for exercise 1")
    .getByRole("button", { name: "Set impact 5" })
    .click();

  // 4 leaves is below the ≥5 threshold, so the umbrella toggle defaults OFF
  // and its title field is hidden until the toggle is turned on (#161).
  const umbrellaToggle = goalCard.getByTitle("Group under one parent task");
  await expect(umbrellaToggle).not.toBeChecked();
  await expect(goalCard.getByTitle("Umbrella task title")).not.toBeVisible();
  await umbrellaToggle.check();

  // The umbrella title now derives from the GOAL, not the source file (#161).
  const parentInput = goalCard.getByTitle("Umbrella task title");
  await expect(parentInput).toHaveValue(`${GOAL_TITLE} — generated plan`);
  await parentInput.fill(PARENT_TITLE);

  // Everything so far was review only — not a single task write.
  expect(taskWrites).toHaveLength(0);

  await goalCard.getByRole("button", { name: "Add 4 tasks" }).click();

  // Gate on the POSITIVE settled signal — the umbrella + 4 leaves counted on
  // the goal — rather than a short negative wait for the panel to close (#131).
  // The commit is TWO writes (parent, then the subtasks batch) plus a query
  // refetch; under full-suite load that round-trip can exceed the default 5s
  // expect timeout, so the old `panel not.toBeVisible` flaked at 5s. Waiting
  // generously on the recount lets the writes land first; the panel is closed
  // by the time the count renders, so the negative check below is then instant.
  await expect(goalCard.getByText("0/5 tasks")).toBeVisible({ timeout: 15_000 });
  await expect(goalCard.getByTitle("Umbrella task title")).not.toBeVisible();
  // Exactly two writes: the parent, then ONE transactional subtasks batch.
  expect(taskWrites).toHaveLength(2);
  expect(taskWrites[1]).toMatch(/\/api\/tasks\/\d+\/subtasks$/);

  // Server state: umbrella parent is an unestimated container, leaves carry
  // the edited values and the provenance description.
  const tasks: {
    title: string;
    effortMinutes: number | null;
    hasOpenChildren: number;
    goalId: number;
    subtasks: {
      title: string;
      description: string | null;
      effortMinutes: number | null;
      impact: number;
    }[];
  }[] = await (await page.request.get("/api/tasks")).json();
  const parent = tasks.find((t) => t.title === PARENT_TITLE)!;
  expect(parent).toBeTruthy();
  expect(parent.effortMinutes).toBeNull();
  expect(parent.hasOpenChildren).toBe(1);
  expect(parent.subtasks).toHaveLength(4);

  const leaf1 = parent.subtasks.find((s) => s.title === "Solve exercise 1 (limits)")!;
  expect(leaf1.effortMinutes).toBe(15); // the panel edit landed
  expect(leaf1.impact).toBe(5); // the review star edit (2 → 5) landed (#161)
  // Provenance cites the material's own numbers, not the edited effort.
  expect(leaf1.description).toBe(`Exercise 1 · 8 pts · ~20 min · ${MATERIAL_NAME}`);

  const edited = parent.subtasks.find((s) => s.title === EDITED_LEAF_TITLE)!;
  expect(edited.effortMinutes).toBe(25);
  expect(edited.description).toBe(`Exercise 3 · 10 pts · ~25 min · ${MATERIAL_NAME}`);

  const parts = parent.subtasks.filter((s) => /part [12]\/2/.test(s.title));
  expect(parts).toHaveLength(2);
  for (const p of parts) {
    expect(p.effortMinutes).toBe(30);
    expect(p.impact).toBe(5);
    expect(p.description).toBe(`Exercise 2 · 12 pts · ~60 min · ${MATERIAL_NAME}`);
  }

  // The tree renders as umbrella + nested leaves on the Tasks page.
  await page.goto("/tasks");
  await expect(page.getByText(PARENT_TITLE)).toBeVisible();
  await expect(page.getByText(EDITED_LEAF_TITLE)).toBeVisible();
});

test("import leaves needing triage fold into one collapsible strip group (#30)", async ({
  page,
}) => {
  // The passive ready group dissolved with the Capture page (#151) — sibling
  // folding now lives where triage happens: knock two part estimates out via
  // the API and the strip's "Needs an estimate" section must cluster them
  // under their umbrella instead of flooding the section with flat rows.
  const tasks: { title: string; subtasks: { id: number; title: string }[] }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  const parts = tasks
    .find((t) => t.title === PARENT_TITLE)!
    .subtasks.filter((s) => /part [12]\/2/.test(s.title));
  expect(parts).toHaveLength(2);
  for (const p of parts) {
    await page.request.patch(`/api/tasks/${p.id}`, { data: { effortMinutes: null } });
  }

  try {
    await page.goto("/tasks");
    const group = triageStrip(page).locator("details").filter({ hasText: PARENT_TITLE });
    // One header row wearing the count — not two flat rows drowning the list.
    await expect(group.locator("summary")).toContainText(PARENT_TITLE);
    await expect(group.locator("summary")).toContainText("(2)");
    await expect(group.getByText(parts[0].title)).not.toBeVisible();
    await group.locator("summary").click();
    await expect(group.getByText(parts[0].title)).toBeVisible();
    await expect(group.getByText(parts[1].title)).toBeVisible();
  } finally {
    // Restore the estimates EVEN when an assert above fails — the next
    // test's goal-filtered draw needs all four leaves drawable, and one red
    // test must not cascade into the rest of the serial file.
    for (const p of parts) {
      await page.request.patch(`/api/tasks/${p.id}`, { data: { effortMinutes: 30 } });
    }
  }
  // API writes don't invalidate the client's query cache — reload to see
  // the strip let go of the cluster.
  await page.reload();
  await expect(triageStrip(page).getByText(parts[0].title)).toHaveCount(0);
});

test("a drawn leaf shows the provenance description on the card", async ({ page }) => {
  // All 4 leaves are ≤ max_draw_effort and the umbrella is a container, so a
  // goal-filtered draw always lands on a leaf carrying the provenance line.
  await drawFromGoal(page, GOAL_TITLE);
  await expect(
    page.locator(".draw-face.back").getByText(new RegExp(`Exercise \\d · .*${MATERIAL_NAME}`)),
  ).toBeVisible();
});

test("a 503 from the real degraded server surfaces as the Settings hint, not a silent failure", async ({
  page,
}) => {
  // Status is mocked to configured, but estimate/generate go to the real
  // server, which has no key — the panel must render the way forward.
  await mockConfigured(page);

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await goalCard.getByRole("button", { name: "✨ Generate tasks" }).click();
  await goalCard
    .getByTitle("What should Claude extract?")
    .fill("One task per exercise of the exam");
  await goalCard.getByRole("button", { name: "Estimate cost" }).click();

  await expect(
    goalCard.getByText("Claude AI is not configured — add your API key in Settings."),
  ).toBeVisible();
});

// --- Optional umbrella (#161) ---------------------------------------------
// The umbrella is now opt-in: a small hand-generated set lands as plain
// goal-linked roots, a large import stays folded under one container. The
// toggle's default is pinned to the ≥5-leaf threshold, always overridable.

async function seedGoal(page: Page, title: string, materialName: string, body: string) {
  const goal = await (
    await page.request.post("/api/goals", {
      data: { title, outcome: "measured somehow", targetDate: "2027-01-01" },
    })
  ).json();
  await page.request.post(`/api/goals/${goal.id}/materials`, {
    multipart: {
      file: { name: materialName, mimeType: "text/plain", buffer: Buffer.from(body) },
    },
  });
  return goal;
}

// 2 model-rated exercises, 2 leaves — below the ≥5 threshold, so the umbrella
// defaults OFF.
const SMALL_RESULT = {
  sourceOverview: "A short two-section warm-up.",
  oversizedParts: false,
  tasks: [
    {
      label: "1",
      title: "Read section 1",
      points: null,
      statedMinutes: 20,
      estimatedMinutes: 20,
      suggestedImpact: 3,
      rationale: "Section 1 overview",
      parts: [],
      impact: 3,
      impactSource: "model",
    },
    {
      label: "2",
      title: "Summarize section 1",
      points: null,
      statedMinutes: 15,
      estimatedMinutes: 15,
      suggestedImpact: 2,
      rationale: "Recap the section",
      parts: [],
      impact: 2,
      impactSource: "model",
    },
  ],
};

// 6 exercises, 6 leaves — at/above the threshold, so the umbrella defaults ON.
const LARGE_RESULT = {
  sourceOverview: "Six exam exercises.",
  oversizedParts: false,
  tasks: Array.from({ length: 6 }, (_, i) => ({
    label: String(i + 1),
    title: `Solve exercise ${i + 1}`,
    points: 10,
    statedMinutes: 30,
    estimatedMinutes: 30,
    suggestedImpact: 3,
    rationale: `Ex. ${i + 1} per the PDF`,
    parts: [],
    impact: 3,
    impactSource: "points",
  })),
};

test("a small set defaults to no umbrella and commits goal-linked roots (#161)", async ({
  page,
}) => {
  const goal = await seedGoal(page, "Small hand-picked set", "notes.txt", "Section 1 ... Section 2");
  await mockConfigured(page);
  await page.route("**/api/ai/estimate", (route) =>
    route.fulfill({ json: { inputTokens: 1200, estimatedUsd: 0.01 } }),
  );
  await page.route("**/api/ai/generate-tasks", (route) => route.fulfill({ json: SMALL_RESULT }));

  const taskWrites: string[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.startsWith("/api/tasks")) {
      taskWrites.push(new URL(req.url()).pathname);
    }
  });

  await page.goto("/goals");
  const goalCard = card(page, "Small hand-picked set");
  await goalCard.getByRole("button", { name: "✨ Generate tasks" }).click();
  await goalCard.getByText("📄 notes.txt").click();
  await goalCard.getByTitle("What should Claude extract?").fill("One task per section");
  await goalCard.getByRole("button", { name: "Estimate cost" }).click();
  await goalCard.getByRole("button", { name: "Ask Claude" }).click();

  // Below the threshold: the umbrella toggle is OFF and its title field hidden.
  await expect(goalCard.getByTitle("Group under one parent task")).not.toBeChecked();
  await expect(goalCard.getByTitle("Umbrella task title")).not.toBeVisible();

  // Both rows are model-rated, so both wear the "(model estimate)" annotation…
  await expect(goalCard.getByText("(model estimate)")).toHaveCount(2);
  // …until the user corrects one — touching exercise 1's picker drops its note.
  await goalCard
    .getByTitle("Impact for exercise 1")
    .getByRole("button", { name: "Set impact 5" })
    .click();
  await expect(goalCard.getByText("(model estimate)")).toHaveCount(1);

  await goalCard.getByRole("button", { name: "Add 2 tasks" }).click();

  // Two root writes, no subtasks batch — nothing was grouped under a parent.
  await expect(goalCard.getByText("0/2 tasks")).toBeVisible({ timeout: 15_000 });
  expect(taskWrites).toEqual(["/api/tasks", "/api/tasks"]);

  // Server state: two goal-linked ROOTS (no parent), the corrected impact on
  // exercise 1, and the provenance description on each.
  const roots: {
    title: string;
    parentId: number | null;
    goalId: number;
    impact: number;
    description: string | null;
    subtasks: unknown[];
  }[] = await (await page.request.get(`/api/tasks?goalId=${goal.id}`)).json();
  expect(roots).toHaveLength(2);
  expect(roots.every((t) => t.parentId === null && t.goalId === goal.id)).toBe(true);
  expect(roots.every((t) => t.subtasks.length === 0)).toBe(true);
  const read = roots.find((t) => t.title === "Read section 1")!;
  expect(read.impact).toBe(5); // the review star edit (3 → 5) landed
  expect(read.description).toContain("notes.txt");
  expect(roots.find((t) => t.title === "Summarize section 1")!.impact).toBe(2);

  // They render as top-level rows on the Tasks page, not nested under a parent.
  await page.goto("/tasks");
  await expect(taskTree(page).getByText("Read section 1")).toBeVisible();
  await expect(taskTree(page).getByText("Summarize section 1")).toBeVisible();
});

test("a large set defaults to the umbrella and folds under one goal-named parent (#161)", async ({
  page,
}) => {
  const goal = await seedGoal(page, "Large exam import", "exam.txt", "Ex 1 ... Ex 6");
  await mockConfigured(page);
  await page.route("**/api/ai/estimate", (route) =>
    route.fulfill({ json: { inputTokens: 9000, estimatedUsd: 0.05 } }),
  );
  await page.route("**/api/ai/generate-tasks", (route) => route.fulfill({ json: LARGE_RESULT }));

  const taskWrites: string[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.startsWith("/api/tasks")) {
      taskWrites.push(new URL(req.url()).pathname);
    }
  });

  await page.goto("/goals");
  const goalCard = card(page, "Large exam import");
  await goalCard.getByRole("button", { name: "✨ Generate tasks" }).click();
  await goalCard.getByText("📄 exam.txt").click();
  await goalCard.getByTitle("What should Claude extract?").fill("One task per exercise");
  await goalCard.getByRole("button", { name: "Estimate cost" }).click();
  await goalCard.getByRole("button", { name: "Ask Claude" }).click();

  // At/above the threshold: the umbrella defaults ON with a goal-derived title.
  await expect(goalCard.getByTitle("Group under one parent task")).toBeChecked();
  await expect(goalCard.getByTitle("Umbrella task title")).toHaveValue(
    "Large exam import — generated plan",
  );

  await goalCard.getByRole("button", { name: "Add 6 tasks" }).click();

  // Two writes: the parent, then ONE transactional subtasks batch.
  await expect(goalCard.getByText("0/7 tasks")).toBeVisible({ timeout: 15_000 });
  expect(taskWrites).toHaveLength(2);
  expect(taskWrites[1]).toMatch(/\/api\/tasks\/\d+\/subtasks$/);

  // Server state: one unestimated container parent holding all six leaves.
  const roots: {
    title: string;
    effortMinutes: number | null;
    goalId: number;
    subtasks: unknown[];
  }[] = await (await page.request.get(`/api/tasks?goalId=${goal.id}`)).json();
  expect(roots).toHaveLength(1);
  expect(roots[0].title).toBe("Large exam import — generated plan");
  expect(roots[0].effortMinutes).toBeNull();
  expect(roots[0].subtasks).toHaveLength(6);
});
