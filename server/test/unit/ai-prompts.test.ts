import { describe, expect, it } from "vitest";
import {
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
