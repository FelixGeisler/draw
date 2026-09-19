import { describe, expect, it } from "vitest";
import { PushAdmission, PUSH_ADMISSION_WINDOW_MS } from "../../src/push/admission.js";

describe("Push admission", () => {
  it("has four no-queue permits and releases idempotently", () => {
    let now = 0;
    const admission = new PushAdmission(() => now);
    const held = Array.from({ length: 4 }, (_, index) => admission.tryAcquire(`client-${index}`));
    expect(held.every((decision) => decision.allowed)).toBe(true);
    expect(admission.tryAcquire("fifth")).toEqual({ allowed: false, error: "push-busy" });
    if (held[0].allowed) { held[0].release(); held[0].release(); }
    expect(admission.tryAcquire("fifth").allowed).toBe(true);
  });

  it("retains accepted attempts, enforces rolling client/global limits, and returns the longest exact remainder", () => {
    let now = 0;
    const admission = new PushAdmission(() => now);
    for (let index = 0; index < 4; index++) {
      now = index * 1_000;
      const decision = admission.tryAcquire("same");
      expect(decision.allowed).toBe(true);
      if (decision.allowed) decision.release();
    }
    now = 10_001;
    expect(admission.tryAcquire("same")).toEqual({ allowed: false, error: "push-rate-limited", retryAfter: 50 });

    now = 60_000;
    const pruned = admission.tryAcquire("same");
    expect(pruned.allowed).toBe(true); // age === window is expired
    if (pruned.allowed) pruned.release();

    now = 0;
    const global = new PushAdmission(() => now);
    for (let index = 0; index < 16; index++) {
      now = index * 10;
      const decision = global.tryAcquire(`client-${index}`);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) decision.release();
    }
    now = 1_000;
    expect(global.tryAcquire("extra")).toEqual({ allowed: false, error: "push-rate-limited", retryAfter: 59 });
  });

  it("prunes empty buckets and proves the seeded 64-client guard directly", () => {
    let now = PUSH_ADMISSION_WINDOW_MS;
    const expired = new PushAdmission(() => now, { clients: [["old", [0]]], global: [0] });
    const accepted = expired.tryAcquire("new");
    expect(accepted.allowed).toBe(true);
    expect(expired.snapshot().clients).toBe(1);
    if (accepted.allowed) accepted.release();

    now = 1;
    const clients = Array.from({ length: 64 }, (_, index) => [`seed-${index}`, [0]] as const);
    const guarded = new PushAdmission(() => now, { clients });
    expect(guarded.tryAcquire("new")).toEqual({ allowed: false, error: "push-busy" });
    const existing = guarded.tryAcquire("seed-0");
    expect(existing.allowed).toBe(true);
  });
});
