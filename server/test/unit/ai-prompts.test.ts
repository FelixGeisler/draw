import { describe, expect, it } from "vitest";
import {
  AiError,
  CARD_ART_SYSTEM_PROMPT,
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

// Card art (#27) cannot be exercised live in tests either — what CAN be
// pinned is the prompt constraints the sanitizer and deck aesthetic rely on.
// #113 moved the LOOK into per-task directives (cardArtStyle.ts, tested in
// card-art-style.test.ts); this prompt keeps only the hard rules.
describe("card art system prompt (#27, #113)", () => {
  it("pins the card geometry and the no-text rule", () => {
    expect(CARD_ART_SYSTEM_PROMPT).toContain('viewBox="0 0 300 420"');
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/NO text/);
  });

  it("anchors the dark deck palette, with the harmony built around the category color (#113)", () => {
    // #255 card-table follow-up: the anchors are the slate card-stock tones
    // (DrawPage.css .draw-face.back), not the retired charcoal app background.
    expect(CARD_ART_SYSTEM_PROMPT).toContain("#171d24");
    expect(CARD_ART_SYSTEM_PROMPT).toContain("#232a33");
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/palette harmony built around the task's category color/);
    // the one-recipe accent rule is gone — it made every card converge
    expect(CARD_ART_SYSTEM_PROMPT).not.toMatch(/single accent/);
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/light card text that must stay legible/);
  });

  it("directs the model to follow the per-request style directives (#113)", () => {
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/style archetype, a palette harmony and a composition/);
  });

  it("composes for the portrait art window the TCG frame (#115) will crop", () => {
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/portrait art window/);
    expect(CARD_ART_SYSTEM_PROMPT).toMatch(/upper-center/);
  });

  it("bans the constructs the sanitizer strips, so good output survives it", () => {
    for (const banned of ["<script>", "<foreignObject>", "<image>", "no external references"]) {
      expect(CARD_ART_SYSTEM_PROMPT).toContain(banned);
    }
  });

  it("does not inherit the planning or transcription directives", () => {
    expect(CARD_ART_SYSTEM_PROMPT).not.toMatch(/30 minutes|activation energy|VERBATIM/i);
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
