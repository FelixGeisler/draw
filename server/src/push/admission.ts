export const PUSH_CONCURRENCY_LIMIT = 4;
export const PUSH_CLIENT_ATTEMPT_LIMIT = 4;
export const PUSH_GLOBAL_ATTEMPT_LIMIT = 16;
export const PUSH_ADMISSION_WINDOW_MS = 60_000;
export const PUSH_CLIENT_BUCKET_LIMIT = 64;
export const PUSH_TEST_DEVICE_WINDOW_MS = 10_000;
export const PUSH_TEST_GLOBAL_WINDOW_MS = 60_000;
export const PUSH_TEST_GLOBAL_ATTEMPT_LIMIT = 16;

export type AdmissionDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; error: "push-busy" }
  | { allowed: false; error: "push-rate-limited"; retryAfter: number };

export interface AdmissionSeed {
  global?: readonly number[];
  clients?: Iterable<readonly [string, readonly number[]]>;
  active?: number;
  testGlobal?: readonly number[];
  testDevices?: Iterable<readonly [string, readonly number[]]>;
  testInFlight?: Iterable<string>;
}

/** Process-local, no-queue admission shared by enrollment and sending. */
export class PushAdmission {
  private active: number;
  private readonly global: number[];
  private readonly clients: Map<string, number[]>;
  private readonly testGlobal: number[];
  private readonly testDevices: Map<string, number[]>;
  private readonly testInFlight: Set<string>;
  private readonly pendingDeviceRemoval = new Set<string>();

  constructor(
    private readonly monotonicNow: () => number = () => performance.now(),
    seed: AdmissionSeed = {},
  ) {
    this.active = seed.active ?? 0;
    this.global = [...(seed.global ?? [])];
    this.clients = new Map(
      [...(seed.clients ?? [])].map(([key, values]) => [key, [...values]]),
    );
    this.testGlobal = [...(seed.testGlobal ?? [])];
    this.testDevices = new Map(
      [...(seed.testDevices ?? [])].map(([key, values]) => [key, [...values]]),
    );
    this.testInFlight = new Set(seed.testInFlight ?? []);
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
    while (this.testGlobal.length > 0 && now - this.testGlobal[0] >= PUSH_TEST_GLOBAL_WINDOW_MS) {
      this.testGlobal.shift();
    }
    for (const [deviceId, timestamps] of this.testDevices) {
      while (timestamps.length > 0 && now - timestamps[0] >= PUSH_TEST_DEVICE_WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length === 0 && !this.testInFlight.has(deviceId)) {
        this.testDevices.delete(deviceId);
        this.pendingDeviceRemoval.delete(deviceId);
      }
    }
  }

  private acquirePermit(): (() => void) | undefined {
    if (this.active >= PUSH_CONCURRENCY_LIMIT) return undefined;
    this.active += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.active -= 1;
    };
  }

  /** Scheduler-only no-queue admission: the shared physical permit, no API buckets. */
  tryAcquireScheduled(): { release: () => void } | undefined {
    const release = this.acquirePermit();
    return release ? { release } : undefined;
  }

  tryAcquire(clientKey: string): AdmissionDecision {
    const release = this.acquirePermit();
    if (!release) return { allowed: false, error: "push-busy" };

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
      return { allowed: false, error: "push-rate-limited", retryAfter: this.retryAfter(remainders) };
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

  tryAcquireTest(deviceId: string): AdmissionDecision {
    const releasePermit = this.acquirePermit();
    if (!releasePermit) return { allowed: false, error: "push-busy" };

    const now = this.monotonicNow();
    this.prune(now);
    if (this.testInFlight.has(deviceId)) {
      releasePermit();
      return { allowed: false, error: "push-busy" };
    }

    const device = this.testDevices.get(deviceId);
    const remainders: number[] = [];
    if (device && device.length >= 1) {
      remainders.push(PUSH_TEST_DEVICE_WINDOW_MS - (now - device[0]));
    }
    if (this.testGlobal.length >= PUSH_TEST_GLOBAL_ATTEMPT_LIMIT) {
      remainders.push(PUSH_TEST_GLOBAL_WINDOW_MS - (now - this.testGlobal[0]));
    }
    if (remainders.length > 0) {
      releasePermit();
      return { allowed: false, error: "push-rate-limited", retryAfter: this.retryAfter(remainders) };
    }

    this.testInFlight.add(deviceId);
    this.testGlobal.push(now);
    if (device) device.push(now);
    else this.testDevices.set(deviceId, [now]);
    let held = true;
    return {
      allowed: true,
      release: () => {
        if (!held) return;
        held = false;
        this.testInFlight.delete(deviceId);
        if (this.pendingDeviceRemoval.delete(deviceId)) this.testDevices.delete(deviceId);
        releasePermit();
      },
    };
  }

  /** Call only after the corresponding row deletion commits. */
  removeDevice(deviceId: string): void {
    if (this.testInFlight.has(deviceId)) this.pendingDeviceRemoval.add(deviceId);
    else this.testDevices.delete(deviceId);
  }

  private retryAfter(remainders: number[]): number {
    return Math.min(60, Math.max(1, Math.ceil(Math.max(...remainders) / 1_000)));
  }

  /** Test observation only; production behavior never branches on it. */
  snapshot(): { active: number; global: number; clients: number; testGlobal: number; testDevices: number; testInFlight: number } {
    this.prune(this.monotonicNow());
    return {
      active: this.active,
      global: this.global.length,
      clients: this.clients.size,
      testGlobal: this.testGlobal.length,
      testDevices: this.testDevices.size,
      testInFlight: this.testInFlight.size,
    };
  }
}
