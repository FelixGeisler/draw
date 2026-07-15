import { describe, expect, it } from "vitest";
import {
  AiError,
  estimateMode,
  PLANNING_SYSTEM_PROMPT,
  TRANSCRIPTION_SYSTEM_PROMPT,
} from "../../src/services/aiService.js";

// The live messages.parse path cannot run without a key, so the one property
// that CAN be pinned deterministically is the prompt text itself: transcription
// mode must never inherit the planning directives that push the model to
// shrink the material's own numbers at the source (review finding on #42 —
// corruption post-processing can neither detect nor repair).
describe("per-mode system prompts", () => {
  it("keeps the planning directives in the planning prompt only", () => {
    expect(PLANNING_SYSTEM_PROMPT).toContain("30 minutes or less");
    expect(PLANNING_SYSTEM_PROMPT).toContain("FIRST task");

    expect(TRANSCRIPTION_SYSTEM_PROMPT).not.toMatch(/30 minutes/i);
    expect(TRANSCRIPTION_SYSTEM_PROMPT).not.toMatch(/FIRST task|activation energy/i);
  });

  it("orders the transcription prompt to copy the material's numbers verbatim", () => {
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toMatch(/VERBATIM/);
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toMatch(/never adjust, shrink, or round/);
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toMatch(/material's own order/);
  });

  it("shares the title and impact conventions across both modes", () => {
    for (const prompt of [PLANNING_SYSTEM_PROMPT, TRANSCRIPTION_SYSTEM_PROMPT]) {
      expect(prompt).toContain("concrete physical action verb");
      expect(prompt).toContain("Impact ratings (1-5) measure leverage");
    }
  });
});

// PR #42 nit (deferred to #29): an estimate must token-count the prompt shape
// of the call it gates. A goal estimate carrying an instruction is a
// generate-tasks estimate — before this mapping existed it counted the
// plan-goal context and mispriced the paid call.
describe("estimateMode (estimate mirrors the paid call's prompt shape)", () => {
  it("routes a goal estimate with an instruction to generate-tasks", () => {
    expect(estimateMode({ goalId: 1, instruction: "one task per exercise" })).toBe(
      "generate-tasks",
    );
  });

  it("keeps instruction-less goal estimates on plan-goal, task estimates on breakdown", () => {
    expect(estimateMode({ goalId: 1 })).toBe("plan-goal");
    expect(estimateMode({ taskId: 7 })).toBe("breakdown");
  });

  it("treats a whitespace-only or non-string instruction as absent", () => {
    expect(estimateMode({ goalId: 1, instruction: "   " })).toBe("plan-goal");
    // Request bodies arrive unvalidated — a non-string must not crash.
    expect(estimateMode({ goalId: 1, instruction: 42 as unknown as string })).toBe("plan-goal");
  });

  it("a taskId wins over a stray instruction — breakdown has no instruction field", () => {
    expect(estimateMode({ taskId: 7, instruction: "ignored" })).toBe("breakdown");
  });

  it("rejects an estimate with neither taskId nor goalId as a 400", () => {
    try {
      estimateMode({});
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AiError);
      expect((e as AiError).status).toBe(400);
    }
  });
});
