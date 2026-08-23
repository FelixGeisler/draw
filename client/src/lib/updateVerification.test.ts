import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_BUDGET_MS,
  UPDATE_POLL_MS,
  UpdateVerifier,
  buildChannelLabel,
  formatElapsedWait,
  type UpdateVerificationStatus,
} from "./updateVerification";

interface Status extends UpdateVerificationStatus {
  buildSha: string | null;
}

const ORIGINAL = "edge:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const unchanged: Status = { buildIdentity: ORIGINAL, lastApplyError: null, buildSha: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(poll: (signal: AbortSignal) => Promise<Status>) {
  const callbacks = {
    poll: vi.fn(poll),
    onPhase: vi.fn(),
    onElapsed: vi.fn(),
    onComplete: vi.fn(),
    onTriggerFailure: vi.fn(),
    onTimeout: vi.fn(),
  };
  return { callbacks, verifier: new UpdateVerifier(callbacks) };
}

describe("update presentation helpers", () => {
  it("maps only the approved build channels to their exact user-facing labels", () => {
    expect(buildChannelLabel("stable")).toBe("Release");
    expect(buildChannelLabel("edge")).toBe("Edge (deployment opt-in)");
    expect(buildChannelLabel("local")).toBe("Local build");
  });

  it("formats elapsed wait without a percentage or estimate", () => {
    expect(formatElapsedWait(0)).toBe("0s");
    expect(formatElapsedWait(59)).toBe("59s");
    expect(formatElapsedWait(60)).toBe("1m 0s");
    expect(formatElapsedWait(299)).toBe("4m 59s");
  });
});

describe("UpdateVerifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every three seconds, reports elapsed wait, and stops cleanly at five minutes", async () => {
    const { callbacks, verifier } = harness(async () => unchanged);

    expect(verifier.start(ORIGINAL)).toBe(true);
    expect(callbacks.onPhase).toHaveBeenLastCalledWith("waiting");
    expect(callbacks.onElapsed).toHaveBeenLastCalledWith(0);

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS - 1);
    expect(callbacks.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.poll).toHaveBeenCalledTimes(1);
    expect(callbacks.onElapsed).toHaveBeenLastCalledWith(3);

    await vi.advanceTimersByTimeAsync(UPDATE_BUDGET_MS - UPDATE_POLL_MS);
    expect(callbacks.poll).toHaveBeenCalledTimes(99);
    expect(callbacks.onTimeout).toHaveBeenCalledOnce();
    expect(callbacks.onElapsed).toHaveBeenLastCalledWith(299);
    expect(verifier.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves from Reconnecting back to Waiting after a successful unchanged poll", async () => {
    let attempt = 0;
    const { callbacks, verifier } = harness(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("container restarting");
      return unchanged;
    });

    verifier.start(ORIGINAL);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.onPhase).toHaveBeenLastCalledWith("reconnecting");
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.onPhase).toHaveBeenLastCalledWith("waiting");
    expect(callbacks.poll).toHaveBeenCalledTimes(2);
  });

  it("stops on an answered trigger failure without waiting for the deadline", async () => {
    const signals: AbortSignal[] = [];
    const { callbacks, verifier } = harness(async (signal) => {
      signals.push(signal);
      return { ...unchanged, lastApplyError: "HTTP 401" };
    });

    verifier.start(ORIGINAL);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.onTriggerFailure).toHaveBeenCalledOnce();
    expect(callbacks.onTriggerFailure).toHaveBeenCalledWith("HTTP 401");
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(verifier.isActive()).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes once, aborts its transport, and has no duplicate effects", async () => {
    const replacement = {
      buildIdentity: "edge:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      lastApplyError: null,
      buildSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const signals: AbortSignal[] = [];
    const { callbacks, verifier } = harness(async (signal) => {
      signals.push(signal);
      return replacement;
    });

    verifier.start(ORIGINAL);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.onComplete).toHaveBeenCalledOnce();
    expect(callbacks.onComplete).toHaveBeenCalledWith(replacement);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(UPDATE_BUDGET_MS);
    expect(callbacks.poll).toHaveBeenCalledOnce();
    expect(callbacks.onComplete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an unresolved timeout poll and prevents timeout → resume overlap", async () => {
    const first = deferred<Status>();
    const second = deferred<Status>();
    const signals: AbortSignal[] = [];
    const { callbacks, verifier } = harness((signal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });

    verifier.start(ORIGINAL);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.poll).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(UPDATE_BUDGET_MS - UPDATE_POLL_MS);
    expect(callbacks.onTimeout).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(true);

    // Resume may establish a fresh bounded window immediately, but the one
    // shared guard remains until the aborted promise settles.
    expect(verifier.start(ORIGINAL)).toBe(true);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.poll).toHaveBeenCalledOnce();

    first.reject(new DOMException("aborted", "AbortError"));
    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(callbacks.onPhase).not.toHaveBeenCalledWith("reconnecting");

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.poll).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    verifier.cancel();
    expect(signals[1]?.aborted).toBe(true);
    second.reject(new DOMException("aborted", "AbortError"));
    await expect(second.promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(callbacks.onPhase).not.toHaveBeenCalledWith("reconnecting");
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes as one fresh bounded window against the same original identity", async () => {
    const { callbacks, verifier } = harness(async () => unchanged);

    verifier.start(ORIGINAL);
    await vi.advanceTimersByTimeAsync(UPDATE_BUDGET_MS);
    expect(callbacks.onTimeout).toHaveBeenCalledOnce();

    expect(verifier.start(ORIGINAL)).toBe(true);
    expect(callbacks.onElapsed).toHaveBeenLastCalledWith(0);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(callbacks.poll).toHaveBeenCalledTimes(100);
    expect(callbacks.onTimeout).toHaveBeenCalledOnce();
  });

  it("rejects repeated starts and cancellation aborts an in-flight response", async () => {
    const pending = deferred<Status>();
    const signals: AbortSignal[] = [];
    const { callbacks, verifier } = harness((signal) => {
      signals.push(signal);
      return pending.promise;
    });

    expect(verifier.start(ORIGINAL)).toBe(true);
    expect(verifier.start("local:other")).toBe(false);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    verifier.cancel();
    expect(signals[0]?.aborted).toBe(true);
    pending.reject(new DOMException("aborted", "AbortError"));
    await expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();

    expect(callbacks.poll).toHaveBeenCalledOnce();
    expect(callbacks.onPhase).not.toHaveBeenCalledWith("reconnecting");
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onTriggerFailure).not.toHaveBeenCalled();
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
