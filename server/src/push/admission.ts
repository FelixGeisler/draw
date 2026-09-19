export const PUSH_CONCURRENCY_LIMIT = 4;
export const PUSH_CLIENT_ATTEMPT_LIMIT = 4;
export const PUSH_GLOBAL_ATTEMPT_LIMIT = 16;
export const PUSH_ADMISSION_WINDOW_MS = 60_000;
export const PUSH_CLIENT_BUCKET_LIMIT = 64;

export type AdmissionDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; error: "push-busy" }
  | { allowed: false; error: "push-rate-limited"; retryAfter: number };

export interface AdmissionSeed {
  global?: readonly number[];
  clients?: Iterable<readonly [string, readonly number[]]>;
  active?: number;
}

/** Process-local, no-queue admission shared by enrollment and the later sender. */
export class PushAdmission {
  private active: number;
  private readonly global: number[];
  private readonly clients: Map<string, number[]>;

  constructor(
    private readonly monotonicNow: () => number = () => performance.now(),
    seed: AdmissionSeed = {},
  ) {
    this.active = seed.active ?? 0;
    this.global = [...(seed.global ?? [])];
    this.clients = new Map(
      [...(seed.clients ?? [])].map(([key, values]) => [key, [...values]]),
    );
  }

  private prune(now: number): void {
    while (this.global.length > 0 && now - this.global[0] >= PUSH_ADMISSION_WINDOW_MS) {
      this.global.shift();
    }
    for (const [key, timestamps] of this.clients) {
      while (timestamps.length > 0 && now - timestamps[0] >= PUSH_ADMISSION_WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length === 0) this.clients.delete(key);
    }
  }

  tryAcquire(clientKey: string): AdmissionDecision {
    if (this.active >= PUSH_CONCURRENCY_LIMIT) return { allowed: false, error: "push-busy" };
    this.active += 1;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.active -= 1;
    };

    const now = this.monotonicNow();
    this.prune(now);
    const client = this.clients.get(clientKey);
    const remainders: number[] = [];
    if (client && client.length >= PUSH_CLIENT_ATTEMPT_LIMIT) {
      remainders.push(PUSH_ADMISSION_WINDOW_MS - (now - client[0]));
    }
    if (this.global.length >= PUSH_GLOBAL_ATTEMPT_LIMIT) {
      remainders.push(PUSH_ADMISSION_WINDOW_MS - (now - this.global[0]));
    }
    if (remainders.length > 0) {
      release();
      const retryAfter = Math.min(60, Math.max(1, Math.ceil(Math.max(...remainders) / 1_000)));
      return { allowed: false, error: "push-rate-limited", retryAfter };
    }
    if (!client && this.clients.size >= PUSH_CLIENT_BUCKET_LIMIT) {
      release();
      return { allowed: false, error: "push-busy" };
    }

    this.global.push(now);
    if (client) client.push(now);
    else this.clients.set(clientKey, [now]);
    return { allowed: true, release };
  }

  /** Test observation only; production behavior never branches on it. */
  snapshot(): { active: number; global: number; clients: number } {
    return { active: this.active, global: this.global.length, clients: this.clients.size };
  }
}
