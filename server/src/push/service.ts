import crypto from "node:crypto";
import net from "node:net";
import type Database from "better-sqlite3";
import type { Request } from "express";
import webPush, { type RequestDetails, type RequestOptions, type PushSubscription } from "web-push";
import { VAPID_SUBJECT, type PushDependency as PushLifecycleDependency, type PushLifecycle, type PushSnapshot } from "./authority.js";
import { PushAdmission } from "./admission.js";
import { PushResolutionError, nodeResolverFactory, resolvePushEndpoint, type ResolverFactory } from "./resolver.js";
import { evaluatePushTopology, type PushTopologyOptions, type TopologyResult } from "./topology.js";
import { inertPushTransport, type PushTransport } from "./transport.js";

export const MAX_PUSH_DEVICES = 16;
export const MAX_ENDPOINT_BYTES = 2_048;
export const MAX_EXPIRATION_TIME = 8_640_000_000_000_000;

export class PushApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export interface ValidSubscription {
  endpoint: string;
  hostname: string;
  expirationTime: number | null;
  p256dh: string;
  auth: string;
  replaceDeviceId?: string;
}

export interface PushDevice {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PushStatus {
  available: boolean;
  reason: PushSnapshot["reason"];
  vapidPublicKey: string | null;
  maxDevices: 16;
  preferences: { hideDetails: boolean };
  devices: PushDevice[];
}

export interface PushServiceDependency extends PushLifecycleDependency {
  topology(req: Request, mutation: boolean): TopologyResult;
  status(): PushStatus;
  register(value: unknown, clientKey: string, signal?: AbortSignal): Promise<{ created: boolean; device: PushDevice }>;
  testDevice(deviceId: string, signal?: AbortSignal): Promise<void>;
  deleteDevice(deviceId: string): void;
  revokeAllDevices(): void;
  setPreferences(value: unknown): { hideDetails: boolean };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function canonicalKey(value: unknown, characters: number, bytes: number): string {
  if (typeof value !== "string" || value.length !== characters || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PushApiError(400, "invalid-push-request");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new PushApiError(400, "invalid-push-request");
  }
  return value;
}

function validDnsHostname(value: string): boolean {
  return value.length <= 253 && !value.endsWith(".") && value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function hasCredentialOrFragmentDelimiter(value: string): boolean {
  // Match the preprocessing performed by the WHATWG basic URL parser before
  // locating syntax: trim leading/trailing C0 controls and space, and remove
  // ASCII tab/newline characters anywhere in the input.
  const input = value
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    .replace(/[\u0009\u000a\u000d]/g, "");
  if (input.includes("#")) return true;

  const schemeEnd = input.indexOf(":");
  if (schemeEnd < 0) return false;
  let authorityStart = schemeEnd + 1;
  // Special-scheme parsing accepts missing, repeated, and backslash authority
  // separators. Skip the same variants rather than assuming "https://".
  while (input[authorityStart] === "/" || input[authorityStart] === "\\") authorityStart++;
  let authorityEnd = authorityStart;
  while (
    authorityEnd < input.length &&
    input[authorityEnd] !== "/" && input[authorityEnd] !== "\\" &&
    input[authorityEnd] !== "?" && input[authorityEnd] !== "#"
  ) authorityEnd++;
  return input.slice(authorityStart, authorityEnd).includes("@");
}

export function validateRegistration(value: unknown, wallNow: number): ValidSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PushApiError(400, "invalid-push-request");
  const root = value as Record<string, unknown>;
  const rootKeys = root.replaceDeviceId === undefined ? ["subscription"] : ["subscription", "replaceDeviceId"];
  if (!exactKeys(root, rootKeys) || !root.subscription || typeof root.subscription !== "object" || Array.isArray(root.subscription)) {
    throw new PushApiError(400, "invalid-push-request");
  }
  if (root.replaceDeviceId !== undefined && !isUuidV4(root.replaceDeviceId)) throw new PushApiError(400, "invalid-push-request");
  const subscription = root.subscription as Record<string, unknown>;
  if (!exactKeys(subscription, ["endpoint", "expirationTime", "keys"]) || typeof subscription.endpoint !== "string") {
    throw new PushApiError(400, "invalid-push-request");
  }
  if (Buffer.byteLength(subscription.endpoint, "utf8") > MAX_ENDPOINT_BYTES) throw new PushApiError(400, "invalid-push-request");
  let endpoint: URL;
  try { endpoint = new URL(subscription.endpoint); } catch { throw new PushApiError(400, "invalid-push-request"); }
  if (
    hasCredentialOrFragmentDelimiter(subscription.endpoint) ||
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.port !== "" ||
    endpoint.hostname.startsWith("[") || net.isIP(endpoint.hostname) !== 0 ||
    !validDnsHostname(endpoint.hostname) || endpoint.hostname !== endpoint.hostname.toLowerCase()
  ) throw new PushApiError(400, "invalid-push-request");

  const expiration = subscription.expirationTime;
  if (
    expiration !== null &&
    (!Number.isSafeInteger(expiration) || (expiration as number) < 0 || (expiration as number) > MAX_EXPIRATION_TIME || (expiration as number) <= wallNow)
  ) throw new PushApiError(400, "invalid-push-request");
  if (!subscription.keys || typeof subscription.keys !== "object" || Array.isArray(subscription.keys)) {
    throw new PushApiError(400, "invalid-push-request");
  }
  const keys = subscription.keys as Record<string, unknown>;
  if (!exactKeys(keys, ["p256dh", "auth"])) throw new PushApiError(400, "invalid-push-request");
  const p256dh = canonicalKey(keys.p256dh, 87, 65);
  if (Buffer.from(p256dh, "base64url")[0] !== 0x04) throw new PushApiError(400, "invalid-push-request");
  try { crypto.ECDH.convertKey(Buffer.from(p256dh, "base64url"), "prime256v1", undefined, undefined, "uncompressed"); }
  catch { throw new PushApiError(400, "invalid-push-request"); }
  const auth = canonicalKey(keys.auth, 22, 16);
  return {
    endpoint: endpoint.href,
    hostname: endpoint.hostname,
    expirationTime: expiration as number | null,
    p256dh,
    auth,
    ...(root.replaceDeviceId === undefined ? {} : { replaceDeviceId: root.replaceDeviceId as string }),
  };
}

function unavailable(snapshot: PushSnapshot): PushApiError {
  return new PushApiError(503, snapshot.reason === "recovery-pending" ? "push-recovery-pending" : "push-unavailable");
}

export interface PushServiceOptions {
  database: Database.Database;
  lifecycle: PushLifecycle;
  topology: PushTopologyOptions;
  admission?: PushAdmission;
  resolverFactory?: ResolverFactory;
  wallNow?: () => number;
  randomUUID?: () => string;
  dnsDeadlineMs?: number;
  totalAttemptMs?: number;
  transport?: PushTransport;
  generateRequestDetails?: (
    subscription: PushSubscription,
    payload: Buffer,
    options: RequestOptions,
  ) => RequestDetails;
}

interface DeviceRow {
  id: string;
  created_at: string;
  last_seen_at: string;
}

interface SendRow extends DeviceRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
}

export class PushService implements PushServiceDependency {
  private readonly admission: PushAdmission;
  private readonly resolverFactory: ResolverFactory;
  private readonly wallNow: () => number;
  private readonly randomUUID: () => string;
  private readonly transport: PushTransport;
  private readonly generateRequestDetails: NonNullable<PushServiceOptions["generateRequestDetails"]>;

  constructor(private readonly options: PushServiceOptions) {
    this.admission = options.admission ?? new PushAdmission();
    this.resolverFactory = options.resolverFactory ?? nodeResolverFactory;
    this.wallNow = options.wallNow ?? Date.now;
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    this.transport = options.transport ?? inertPushTransport;
    this.generateRequestDetails = options.generateRequestDetails ?? ((subscription, payload, requestOptions) =>
      webPush.generateRequestDetails(subscription, payload, requestOptions));
  }

  snapshot() { return this.options.lifecycle.snapshot(); }
  generation() { return this.options.lifecycle.generation(); }
  invalidate() { this.options.lifecycle.invalidate(); }
  reset() { this.options.lifecycle.reset(); }
  beginRestore() { this.options.lifecycle.beginRestore(); }
  completeRestore() { this.options.lifecycle.completeRestore(); }
  abortRestore() { this.options.lifecycle.abortRestore(); }

  topology(req: Request, mutation: boolean): TopologyResult {
    return evaluatePushTopology(req, this.options.topology, mutation);
  }

  status(): PushStatus {
    const snapshot = this.snapshot();
    const preference = this.options.database.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get() as { value: string };
    const rows = this.options.database.prepare(
      "SELECT id, created_at, last_seen_at FROM push_subscriptions ORDER BY created_at, id",
    ).all() as DeviceRow[];
    return {
      available: snapshot.available,
      reason: snapshot.reason,
      vapidPublicKey: snapshot.available ? snapshot.publicVapidKey : null,
      maxDevices: MAX_PUSH_DEVICES,
      preferences: { hideDetails: preference.value === "1" },
      devices: rows.map((row) => ({ id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at })),
    };
  }

  private row(deviceId: string): SendRow | undefined {
    return this.options.database.prepare(
      `SELECT id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at
       FROM push_subscriptions WHERE id = ?`,
    ).get(deviceId) as SendRow | undefined;
  }

  private sameRow(left: SendRow, right: SendRow): boolean {
    return left.id === right.id && left.endpoint === right.endpoint && left.p256dh === right.p256dh &&
      left.auth === right.auth && left.expiration_time === right.expiration_time &&
      left.created_at === right.created_at && left.last_seen_at === right.last_seen_at;
  }

  /** Exact, null-safe fingerprint delete. Callers clear admission state only for one changed row. */
  private deleteFingerprint(row: SendRow): boolean {
    const result = this.options.database.prepare(
      `DELETE FROM push_subscriptions
       WHERE id = ? AND endpoint = ? AND p256dh = ? AND auth = ?
         AND (expiration_time = ? OR (expiration_time IS NULL AND ? IS NULL))
         AND created_at = ? AND last_seen_at = ?`,
    ).run(row.id, row.endpoint, row.p256dh, row.auth, row.expiration_time, row.expiration_time, row.created_at, row.last_seen_at);
    if (result.changes === 1) this.admission.removeDevice(row.id);
    return result.changes === 1;
  }

  private hideDetails(): string {
    return (this.options.database.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get() as { value: string }).value;
  }

  async register(value: unknown, clientKey: string, signal?: AbortSignal): Promise<{ created: boolean; device: PushDevice }> {
    const nowMs = this.wallNow();
    const input = validateRegistration(value, nowMs);
    const before = this.snapshot();
    if (!before.available) throw unavailable(before);
    const workGeneration = this.options.lifecycle.currentWorkGeneration();
    const admission = this.admission.tryAcquire(clientKey);
    if (!admission.allowed) {
      throw new PushApiError(admission.error === "push-rate-limited" ? 429 : 503, admission.error, "retryAfter" in admission ? admission.retryAfter : undefined);
    }
    try {
      await resolvePushEndpoint(input.hostname, this.resolverFactory, signal, this.options.dnsDeadlineMs ?? 2_000);
      const after = this.snapshot();
      if (!after.available || this.options.lifecycle.currentWorkGeneration() !== workGeneration) throw unavailable(after);
      const timestamp = new Date(nowMs).toISOString();
      const committed = this.options.database.transaction(() => {
        const same = this.options.database.prepare("SELECT id, created_at, last_seen_at FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint) as DeviceRow | undefined;
        let id: string;
        let createdAt: string;
        const removed: string[] = [];
        const replacement = input.replaceDeviceId
          ? this.options.database.prepare("SELECT id FROM push_subscriptions WHERE id = ?").get(input.replaceDeviceId) as { id: string } | undefined
          : undefined;
        if (same) {
          id = same.id;
          createdAt = same.created_at;
          if (replacement && replacement.id !== same.id) {
            this.options.database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(replacement.id);
            removed.push(replacement.id);
          }
        } else {
          const count = (this.options.database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number }).count;
          if (count - (replacement ? 1 : 0) >= MAX_PUSH_DEVICES) throw new PushApiError(409, "push-device-limit");
          if (replacement) {
            this.options.database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(replacement.id);
            removed.push(replacement.id);
          }
          id = this.randomUUID();
          if (!isUuidV4(id)) throw new Error("UUID source did not return v4");
          createdAt = timestamp;
        }
        this.options.database.prepare(
          `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh=excluded.p256dh, auth=excluded.auth, expiration_time=excluded.expiration_time,
             last_seen_at=excluded.last_seen_at`,
        ).run(id, input.endpoint, input.p256dh, input.auth, input.expirationTime, createdAt, timestamp);
        return { result: { created: !same, device: { id, createdAt, lastSeenAt: timestamp } }, removed };
      })();
      committed.removed.forEach((id) => this.admission.removeDevice(id));
      return committed.result;
    } catch (error) {
      if (error instanceof PushResolutionError) {
        if (error.kind === "timeout") throw new PushApiError(504, "push-timeout");
        if (error.kind === "aborted") throw error;
        throw new PushApiError(502, "push-endpoint-unavailable");
      }
      throw error;
    } finally {
      admission.release();
    }
  }

  async testDevice(deviceId: string, signal?: AbortSignal): Promise<void> {
    if (!isUuidV4(deviceId)) throw new PushApiError(400, "invalid-push-request");
    const before = this.snapshot();
    if (!before.available) throw unavailable(before);
    const initial = this.row(deviceId);
    if (!initial) throw new PushApiError(404, "push-device-not-found");
    const initialNow = this.wallNow();
    if (initial.expiration_time !== null &&
      (typeof initial.expiration_time !== "number" || !Number.isSafeInteger(initial.expiration_time) || initial.expiration_time <= initialNow)) {
      if (typeof initial.expiration_time === "number" && Number.isSafeInteger(initial.expiration_time) && initial.expiration_time <= initialNow) {
        this.deleteFingerprint(initial);
        throw new PushApiError(410, "push-subscription-gone");
      }
    }

    const admission = this.admission.tryAcquireTest(deviceId);
    if (!admission.allowed) {
      throw new PushApiError(admission.error === "push-rate-limited" ? 429 : 503, admission.error, "retryAfter" in admission ? admission.retryAfter : undefined);
    }

    const attempt = new AbortController();
    let totalTimedOut = false;
    const onClientAbort = () => attempt.abort();
    signal?.addEventListener("abort", onClientAbort, { once: true });
    if (signal?.aborted) attempt.abort();
    const timer = setTimeout(() => {
      totalTimedOut = true;
      attempt.abort();
    }, this.options.totalAttemptMs ?? 5_000);

    try {
      const workGeneration = this.options.lifecycle.currentWorkGeneration();
      const signing = this.options.lifecycle.signingAuthority();
      const hideDetails = this.hideDetails();
      if (!signing) throw new PushApiError(409, "push-test-cancelled");

      let validated: ValidSubscription;
      try {
        validated = validateRegistration({
          subscription: {
            endpoint: initial.endpoint,
            expirationTime: initial.expiration_time,
            keys: { p256dh: initial.p256dh, auth: initial.auth },
          },
        }, initialNow);
      } catch {
        throw new PushApiError(502, "push-delivery-failed");
      }
      if (validated.endpoint !== initial.endpoint) throw new PushApiError(502, "push-delivery-failed");

      let address: string;
      try {
        address = await resolvePushEndpoint(
          validated.hostname,
          this.resolverFactory,
          attempt.signal,
          this.options.dnsDeadlineMs ?? 2_000,
        );
      } catch (error) {
        if (error instanceof PushResolutionError) {
          if (error.kind === "timeout" || totalTimedOut) throw new PushApiError(504, "push-timeout");
          if (error.kind === "aborted") throw error;
          throw new PushApiError(502, "push-delivery-failed");
        }
        throw new PushApiError(502, "push-delivery-failed");
      }

      // The final state read, request detail construction, adapter invocation,
      // handler installation, and request.end all occur without an intervening yield.
      const after = this.snapshot();
      const currentSigning = this.options.lifecycle.signingAuthority();
      const current = this.row(deviceId);
      const finalNow = this.wallNow();
      const cancelled = !after.available ||
        this.options.lifecycle.currentWorkGeneration() !== workGeneration ||
        !currentSigning || currentSigning.generation !== signing.generation ||
        currentSigning.publicKey !== signing.publicKey || currentSigning.privateKey !== signing.privateKey ||
        !current || !this.sameRow(initial, current) || this.hideDetails() !== hideDetails;
      if (cancelled) throw new PushApiError(409, "push-test-cancelled");
      if (current.expiration_time !== null && current.expiration_time <= finalNow) {
        this.deleteFingerprint(current);
        throw new PushApiError(409, "push-test-cancelled");
      }
      if (attempt.signal.aborted) {
        if (totalTimedOut) throw new PushApiError(504, "push-timeout");
        throw new PushResolutionError("aborted");
      }

      const clearPayload = Buffer.from('{"v":1,"kind":"test"}', "utf8");
      if (clearPayload.length > 3_072) throw new PushApiError(502, "push-delivery-failed");
      let details: RequestDetails;
      try {
        details = this.generateRequestDetails(
          { endpoint: initial.endpoint, keys: { p256dh: initial.p256dh, auth: initial.auth } },
          clearPayload,
          {
            contentEncoding: "aes128gcm",
            TTL: 0,
            urgency: "normal",
            topic: "draw-push-test",
            vapidDetails: {
              subject: VAPID_SUBJECT,
              publicKey: signing.publicKey,
              privateKey: signing.privateKey,
            },
          },
        );
      } catch {
        throw new PushApiError(502, "push-delivery-failed");
      }
      if (details.endpoint !== initial.endpoint || details.method !== "POST" || details.proxy !== undefined ||
        !Buffer.isBuffer(details.body) || details.body.length > 4_096) {
        throw new PushApiError(502, "push-delivery-failed");
      }

      let outcome: Awaited<ReturnType<PushTransport["send"]>>;
      try {
        outcome = await this.transport.send({
          details: details as RequestDetails & { body: Buffer },
          hostname: validated.hostname,
          address,
          signal: attempt.signal,
          timedOut: () => totalTimedOut,
        });
      } catch {
        if (totalTimedOut) throw new PushApiError(504, "push-timeout");
        if (attempt.signal.aborted) throw new PushResolutionError("aborted");
        throw new PushApiError(502, "push-delivery-failed");
      }
      if (outcome === "success") return;
      if (outcome === "gone") {
        this.deleteFingerprint(initial);
        throw new PushApiError(410, "push-subscription-gone");
      }
      // Transport fixes the logical outcome when provider/network work becomes terminal,
      // but keeps this await pending until every locally owned handle closes. The total
      // timer may fire during that physical cleanup and must not reclassify the earlier
      // terminal outcome.
      if (outcome === "timeout") throw new PushApiError(504, "push-timeout");
      if (outcome === "aborted") throw new PushResolutionError("aborted");
      throw new PushApiError(502, "push-delivery-failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onClientAbort);
      admission.release();
    }
  }

  deleteDevice(deviceId: string): void {
    if (!isUuidV4(deviceId)) throw new PushApiError(400, "invalid-push-request");
    const snapshot = this.snapshot();
    if (!snapshot.available) throw unavailable(snapshot);
    const result = this.options.database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(deviceId);
    if (result.changes === 1) this.admission.removeDevice(deviceId);
  }

  revokeAllDevices(): void {
    const snapshot = this.snapshot();
    if (!snapshot.available) throw unavailable(snapshot);
    try { this.options.lifecycle.revokeAll(); }
    catch {
      const after = this.snapshot();
      throw unavailable(after);
    }
  }

  setPreferences(value: unknown): { hideDetails: boolean } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PushApiError(400, "invalid-push-request");
    const record = value as Record<string, unknown>;
    if (!exactKeys(record, ["hideDetails"]) || typeof record.hideDetails !== "boolean") throw new PushApiError(400, "invalid-push-request");
    const snapshot = this.snapshot();
    if (!snapshot.available) throw unavailable(snapshot);
    this.options.database.prepare("UPDATE settings SET value = ? WHERE key = 'push_hide_details'").run(record.hideDetails ? "1" : "0");
    this.options.lifecycle.advanceWorkGeneration();
    return { hideDetails: record.hideDetails };
  }
}

const notProduction = (): PushSnapshot => ({ available: false, reason: "not-production", publicVapidKey: null, generation: null });
export const disabledPushService: PushServiceDependency = Object.freeze({
  snapshot: notProduction,
  generation: () => null,
  invalidate: () => {}, reset: () => {}, beginRestore: () => {}, completeRestore: () => {}, abortRestore: () => {},
  topology: (): TopologyResult => ({ allowed: false, reason: "secure-transport-required" }),
  status: () => ({
    available: false, reason: "not-production" as const, vapidPublicKey: null, maxDevices: 16 as const,
    preferences: { hideDetails: false }, devices: [],
  }),
  register: async () => { throw new PushApiError(503, "push-unavailable"); },
  testDevice: async () => { throw new PushApiError(503, "push-unavailable"); },
  deleteDevice: () => { throw new PushApiError(503, "push-unavailable"); },
  revokeAllDevices: () => { throw new PushApiError(503, "push-unavailable"); },
  setPreferences: () => { throw new PushApiError(503, "push-unavailable"); },
});
