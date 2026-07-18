import { afterEach, describe, expect, it, vi } from "vitest";
import { celebrate, prefersReducedMotion } from "./celebrate";

// The confetti gate (#148): celebrate is the ONE door to canvas-confetti,
// so these tests pin the gate itself — the burst fires exactly when motion
// is allowed and never under prefers-reduced-motion. The E2E pair in
// draw-confetti-gate.spec.ts pins the same fact against a real browser.
const confettiMock = vi.hoisted(() => vi.fn());
vi.mock("canvas-confetti", () => ({ default: confettiMock }));

function stubMatchMedia(matches: boolean) {
  const matchMedia = vi.fn().mockReturnValue({ matches });
  vi.stubGlobal("window", { matchMedia });
  return matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
  confettiMock.mockClear();
});

describe("prefersReducedMotion", () => {
  it("asks matchMedia for the reduce preference and reports its verdict", () => {
    const matchMedia = stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");

    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("celebrate", () => {
  it("fires the burst with the caller's options when motion is allowed", () => {
    stubMatchMedia(false);
    celebrate({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
    expect(confettiMock).toHaveBeenCalledExactlyOnceWith({
      particleCount: 120,
      spread: 75,
      origin: { y: 0.6 },
    });
  });

  it("skips the burst entirely under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    celebrate({ particleCount: 120 });
    expect(confettiMock).not.toHaveBeenCalled();
  });
});
