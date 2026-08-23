import type { BuildChannel } from "./updateNotice";

export const UPDATE_POLL_MS = 3_000;
export const UPDATE_BUDGET_MS = 5 * 60 * 1000;
export const UPDATE_ELAPSED_MS = 1_000;

export type UpdateVerificationPhase = "waiting" | "reconnecting";

export interface UpdateVerificationStatus {
  buildIdentity: string | null;
  lastApplyError: string | null;
}

interface UpdateVerificationCallbacks<T extends UpdateVerificationStatus> {
  poll: () => Promise<T>;
  onPhase: (phase: UpdateVerificationPhase) => void;
  onElapsed: (elapsedSeconds: number) => void;
  onComplete: (status: T) => void;
  onTriggerFailure: (message: string) => void;
  onTimeout: () => void;
}

const CHANNEL_LABELS: Record<BuildChannel, string> = {
  stable: "Release",
  edge: "Edge (deployment opt-in)",
  local: "Local build",
};

export function buildChannelLabel(channel: BuildChannel): string {
  return CHANNEL_LABELS[channel];
}

export function formatElapsedWait(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * One bounded, non-overlapping update-verification window. The apply POST is
 * intentionally outside this class: restarting a stopped window can only
 * resume GET observation against the caller-supplied original identity.
 */
export class UpdateVerifier<T extends UpdateVerificationStatus> {
  private active = false;
  private inFlight = false;
  private generation = 0;
  private startedAt = 0;
  private originalIdentity = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callbacks: UpdateVerificationCallbacks<T>) {}

  /** Starts a window, or returns false without disturbing an active one. */
  start(originalIdentity: string): boolean {
    if (this.active) return false;

    this.active = true;
    this.inFlight = false;
    this.generation += 1;
    this.startedAt = Date.now();
    this.originalIdentity = originalIdentity;
    const generation = this.generation;

    this.callbacks.onElapsed(0);
    this.callbacks.onPhase("waiting");
    this.pollTimer = setInterval(() => void this.poll(generation), UPDATE_POLL_MS);
    this.elapsedTimer = setInterval(() => {
      if (!this.isCurrent(generation)) return;
      const elapsed = Math.min(
        Math.floor((Date.now() - this.startedAt) / 1000),
        UPDATE_BUDGET_MS / 1000,
      );
      this.callbacks.onElapsed(elapsed);
    }, UPDATE_ELAPSED_MS);
    this.deadlineTimer = setTimeout(() => this.timeout(generation), UPDATE_BUDGET_MS);
    return true;
  }

  /** Cancels timers and makes every late response inert. */
  cancel(): void {
    if (!this.active && this.pollTimer === null && this.elapsedTimer === null) return;
    this.stop();
  }

  isActive(): boolean {
    return this.active;
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.inFlight) return;
    if (Date.now() - this.startedAt >= UPDATE_BUDGET_MS) {
      this.timeout(generation);
      return;
    }

    this.inFlight = true;
    try {
      let status: T;
      try {
        status = await this.callbacks.poll();
      } catch {
        if (this.isCurrent(generation)) this.callbacks.onPhase("reconnecting");
        return;
      }

      if (!this.isCurrent(generation)) return;
      if (status.lastApplyError) {
        this.stop();
        this.callbacks.onTriggerFailure(status.lastApplyError);
        return;
      }
      if (status.buildIdentity !== null && status.buildIdentity !== this.originalIdentity) {
        this.stop();
        this.callbacks.onComplete(status);
        return;
      }
      this.callbacks.onPhase("waiting");
    } finally {
      if (this.generation === generation) this.inFlight = false;
    }
  }

  private timeout(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.stop();
    this.callbacks.onTimeout();
  }

  private stop(): void {
    this.active = false;
    this.inFlight = false;
    this.generation += 1;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.pollTimer = null;
    this.elapsedTimer = null;
    this.deadlineTimer = null;
  }
}
