import { ApiError } from "../api/client";

export const PUSH_DEVICE_KEY = "draw.push.device.v1";
export const MAX_PUSH_PAYLOAD_BYTES = 3_072;

export type PushUnavailableReason =
  | "not-production"
  | "authority-unavailable"
  | "recovery-pending"
  | null;
export type PushMutationReason =
  | "secure-transport-required"
  | "proxy-configuration-unsupported"
  | null;

export interface PushDevice {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PushStatus {
  available: boolean;
  reason: PushUnavailableReason;
  mutationAllowed: boolean;
  mutationReason: PushMutationReason;
  vapidPublicKey: string | null;
  maxDevices: 16;
  preferences: { hideDetails: boolean };
  devices: PushDevice[];
}

export interface BrowserPushSnapshot {
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | "unavailable";
  registration: ServiceWorkerRegistration | null;
  activeWorker: ServiceWorker | null;
  workerIdentity: string | null;
  pushManager: PushManager | null;
  subscription: PushSubscription | null;
  handle: string | null;
  malformedHandle: boolean;
}

export interface EnrollmentPrerequisites {
  status: PushStatus;
  browser: BrowserPushSnapshot;
  vapidBytes: Uint8Array;
}

export type ActivationOperation =
  | { kind: "permission"; promise: Promise<NotificationPermission> }
  | { kind: "unsubscribe"; promise: Promise<boolean>; subscription: PushSubscription }
  | { kind: "subscribe"; promise: Promise<PushSubscription> };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function decodeCanonicalBase64Url(value: unknown, expectedBytes?: number): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value) || value.includes("=")) {
    return null;
  }
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) return null;
    if (encodeBase64Url(bytes) !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function encodeBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function equalBytes(left: ArrayBuffer | ArrayBufferView | null, right: Uint8Array): boolean {
  if (left === null) return false;
  const bytes = left instanceof ArrayBuffer
    ? new Uint8Array(left)
    : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  return bytes.byteLength === right.byteLength && bytes.every((byte, index) => byte === right[index]);
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

export function parsePushStatus(value: unknown): PushStatus {
  const root = object(value);
  if (!root || !exactKeys(root, [
    "available", "reason", "mutationAllowed", "mutationReason", "vapidPublicKey",
    "maxDevices", "preferences", "devices",
  ])) throw new Error("invalid Push status");
  const reasons: PushUnavailableReason[] = [null, "not-production", "authority-unavailable", "recovery-pending"];
  const mutationReasons: PushMutationReason[] = [null, "secure-transport-required", "proxy-configuration-unsupported"];
  const preferences = object(root.preferences);
  if (
    typeof root.available !== "boolean" || !reasons.includes(root.reason as PushUnavailableReason) ||
    typeof root.mutationAllowed !== "boolean" || !mutationReasons.includes(root.mutationReason as PushMutationReason) ||
    root.maxDevices !== 16 || !preferences || !exactKeys(preferences, ["hideDetails"]) ||
    typeof preferences.hideDetails !== "boolean" || !Array.isArray(root.devices)
  ) throw new Error("invalid Push status");
  if (root.available !== (root.reason === null) || root.mutationAllowed !== (root.mutationReason === null)) {
    throw new Error("inconsistent Push status");
  }
  const vapidPublicKey = root.vapidPublicKey;
  if (root.available) {
    const decodedVapid = decodeCanonicalBase64Url(vapidPublicKey, 65);
    if (decodedVapid === null || decodedVapid[0] !== 0x04) throw new Error("invalid Push status");
  } else if (vapidPublicKey !== null) throw new Error("invalid Push status");
  const devices = root.devices.map((entry): PushDevice => {
    const device = object(entry);
    if (!device || !exactKeys(device, ["id", "createdAt", "lastSeenAt"]) ||
      !isCanonicalUuidV4(device.id) || !validIsoTimestamp(device.createdAt) || !validIsoTimestamp(device.lastSeenAt)) {
      throw new Error("invalid Push status");
    }
    return { id: device.id, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
  });
  return {
    available: root.available,
    reason: root.reason as PushUnavailableReason,
    mutationAllowed: root.mutationAllowed,
    mutationReason: root.mutationReason as PushMutationReason,
    vapidPublicKey: vapidPublicKey as string | null,
    maxDevices: 16,
    preferences: { hideDetails: preferences.hideDetails },
    devices,
  };
}

async function closedFetch(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new PushNetworkError();
  }
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const record = object(body);
    const code = record && exactKeys(record, ["error"]) && typeof record.error === "string"
      ? record.error
      : response.statusText;
    throw new ApiError(response.status, code, body);
  }
  return response;
}

async function strictJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new Error("invalid Push response"); }
}

export class PushNetworkError extends Error {
  constructor() { super("Push network unavailable"); }
}

export async function fetchPushStatus(): Promise<PushStatus> {
  const response = await closedFetch("/api/push/status");
  if (response.status !== 200) throw new Error("invalid Push response");
  return parsePushStatus(await strictJson(response));
}

function parseDeviceResponse(value: unknown): PushDevice {
  const root = object(value);
  const device = root && exactKeys(root, ["device"]) ? object(root.device) : null;
  if (!device || !exactKeys(device, ["id", "createdAt", "lastSeenAt"]) ||
    !isCanonicalUuidV4(device.id) || !validIsoTimestamp(device.createdAt) || !validIsoTimestamp(device.lastSeenAt)) {
    throw new Error("invalid Push response");
  }
  return { id: device.id, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
}

export async function registerPushSubscription(
  subscription: PushSubscription,
  replaceDeviceId: string | null,
): Promise<PushDevice> {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || p256dh.byteLength !== 65 || !auth || auth.byteLength !== 16 ||
    typeof subscription.endpoint !== "string" || subscription.endpoint.length === 0 ||
    (subscription.expirationTime !== null && !Number.isSafeInteger(subscription.expirationTime))) {
    throw new Error("invalid browser subscription");
  }
  const body = {
    subscription: {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: { p256dh: encodeBase64Url(p256dh), auth: encodeBase64Url(auth) },
    },
    ...(replaceDeviceId === null ? {} : { replaceDeviceId }),
  };
  const response = await closedFetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200 && response.status !== 201) throw new Error("invalid Push response");
  return parseDeviceResponse(await strictJson(response));
}

export async function setPushPreference(hideDetails: boolean): Promise<boolean> {
  const response = await closedFetch("/api/push/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hideDetails }),
  });
  if (response.status !== 200) throw new Error("invalid Push response");
  const root = object(await strictJson(response));
  if (!root || !exactKeys(root, ["hideDetails"]) || root.hideDetails !== hideDetails) {
    throw new Error("invalid Push response");
  }
  return hideDetails;
}

export async function deletePushDevice(deviceId: string): Promise<void> {
  if (!isCanonicalUuidV4(deviceId)) throw new Error("invalid device id");
  const response = await closedFetch(`/api/push/subscriptions/${deviceId}`, { method: "DELETE" });
  if (response.status !== 204) throw new Error("invalid Push response");
}

export async function revokeAllPushDevices(): Promise<void> {
  const response = await closedFetch("/api/push/subscriptions", { method: "DELETE" });
  if (response.status !== 204) throw new Error("invalid Push response");
}

export async function sendPushTest(deviceId: string): Promise<void> {
  if (!isCanonicalUuidV4(deviceId)) throw new Error("invalid device id");
  const response = await closedFetch(`/api/push/subscriptions/${deviceId}/test`, { method: "POST" });
  if (response.status !== 204) throw new Error("invalid Push response");
}

export async function inspectBrowserPush(): Promise<BrowserPushSnapshot> {
  const secureContext = globalThis.isSecureContext === true;
  const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const hasPushManager = typeof globalThis.PushManager !== "undefined";
  const hasNotification = typeof globalThis.Notification !== "undefined";
  let registration: ServiceWorkerRegistration | null = null;
  let pushManager: PushManager | null = null;
  let subscription: PushSubscription | null = null;
  let activeWorker: ServiceWorker | null = null;
  let workerIdentity: string | null = null;
  if (hasServiceWorker) {
    registration = await navigator.serviceWorker.getRegistration("/") ?? null;
    const active = registration?.active;
    const expectedScope = new URL("/", location.origin).href;
    const expectedScript = new URL("/sw.js", location.origin).href;
    if (!registration || registration.scope !== expectedScope || !active || active.state !== "activated" || active.scriptURL !== expectedScript) {
      registration = null;
    } else {
      activeWorker = active;
      workerIdentity = `${registration.scope}\n${active.scriptURL}\n${active.state}`;
      if (hasPushManager && registration.pushManager) {
        pushManager = registration.pushManager;
        subscription = await pushManager.getSubscription();
      }
    }
  }
  let stored: string | null = null;
  try { stored = localStorage.getItem(PUSH_DEVICE_KEY); } catch { /* unavailable storage is a missing handle */ }
  const handle = isCanonicalUuidV4(stored) ? stored : null;
  return {
    secureContext,
    hasServiceWorker,
    hasPushManager,
    hasNotification,
    permission: hasNotification ? Notification.permission : "unavailable",
    registration,
    activeWorker,
    workerIdentity,
    pushManager,
    subscription,
    handle,
    malformedHandle: stored !== null && handle === null,
  };
}

export function enrollmentPrerequisites(
  status: PushStatus | null,
  browser: BrowserPushSnapshot | null,
): EnrollmentPrerequisites | null {
  if (!status || !browser || !status.available || !status.mutationAllowed || !browser.secureContext ||
    !browser.registration || !browser.pushManager || !browser.hasPushManager || !browser.hasNotification ||
    browser.permission === "denied" || !status.vapidPublicKey) return null;
  const vapidBytes = decodeCanonicalBase64Url(status.vapidPublicKey, 65);
  return vapidBytes && vapidBytes[0] === 0x04 ? { status, browser, vapidBytes } : null;
}

export function subscriptionMatches(subscription: PushSubscription | null, vapidBytes: Uint8Array): boolean {
  return subscription !== null && equalBytes(subscription.options.applicationServerKey, vapidBytes);
}

function equalNullableBuffers(
  left: ArrayBuffer | ArrayBufferView | null,
  right: ArrayBuffer | ArrayBufferView | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftBytes = left instanceof ArrayBuffer
    ? new Uint8Array(left)
    : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = right instanceof ArrayBuffer
    ? new Uint8Array(right)
    : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((byte, index) => byte === rightBytes[index]);
}

/**
 * PushManager may return a fresh JavaScript wrapper for the subscription it
 * just created. Identity is the exact browser subscription data, never the
 * wrapper object reference.
 */
export function sameSubscriptionData(left: PushSubscription, right: PushSubscription): boolean {
  return left.endpoint === right.endpoint &&
    left.expirationTime === right.expirationTime &&
    left.options.userVisibleOnly === right.options.userVisibleOnly &&
    equalNullableBuffers(left.options.applicationServerKey, right.options.applicationServerKey) &&
    equalNullableBuffers(left.getKey("p256dh"), right.getKey("p256dh")) &&
    equalNullableBuffers(left.getKey("auth"), right.getKey("auth"));
}

export function listedHandle(status: PushStatus, handle: string | null): string | null {
  return handle !== null && status.devices.some((device) => device.id === handle) ? handle : null;
}

export function snapshotFingerprint(prerequisites: EnrollmentPrerequisites): string {
  const { status, browser } = prerequisites;
  return JSON.stringify({
    available: status.available,
    mutationAllowed: status.mutationAllowed,
    vapidPublicKey: status.vapidPublicKey,
    permission: browser.permission,
    workerIdentity: browser.workerIdentity,
  });
}

export function samePrerequisites(
  previous: EnrollmentPrerequisites,
  current: EnrollmentPrerequisites | null,
  permissionMayBecomeGranted = false,
): boolean {
  if (!current) return false;
  const previousPermission = previous.browser.permission;
  const permissionMatches = current.browser.permission === previousPermission ||
    permissionMayBecomeGranted && previousPermission === "default" && current.browser.permission === "granted";
  return permissionMatches && previous.status.available === current.status.available &&
    previous.status.mutationAllowed === current.status.mutationAllowed &&
    previous.status.vapidPublicKey === current.status.vapidPublicKey &&
    previous.browser.workerIdentity === current.browser.workerIdentity &&
    previous.browser.activeWorker === current.browser.activeWorker;
}

/** Starts the one activation-sensitive operation before returning to the caller. */
export function beginEnrollmentOperation(
  prerequisites: EnrollmentPrerequisites,
  continuation: boolean,
): ActivationOperation | null {
  const { browser, vapidBytes } = prerequisites;
  if (browser.permission === "default") {
    if (continuation) return null;
    return { kind: "permission", promise: Notification.requestPermission() };
  }
  if (browser.permission !== "granted" || !browser.pushManager) return null;
  if (browser.subscription && !subscriptionMatches(browser.subscription, vapidBytes)) {
    if (continuation) return null;
    return { kind: "unsubscribe", promise: browser.subscription.unsubscribe(), subscription: browser.subscription };
  }
  if (!browser.subscription) {
    return {
      kind: "subscribe",
      promise: browser.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(vapidBytes).buffer,
      }),
    };
  }
  return null;
}

export function clearStoredHandle(expected?: string | null): boolean {
  try {
    const current = localStorage.getItem(PUSH_DEVICE_KEY);
    if (expected !== undefined && current !== expected) return true;
    localStorage.removeItem(PUSH_DEVICE_KEY);
    return true;
  } catch { return false; }
}

export function storeHandle(deviceId: string): boolean {
  if (!isCanonicalUuidV4(deviceId)) return false;
  try {
    localStorage.setItem(PUSH_DEVICE_KEY, deviceId);
    return localStorage.getItem(PUSH_DEVICE_KEY) === deviceId;
  } catch { return false; }
}

export const STATUS_GUIDANCE: Record<Exclude<PushUnavailableReason | PushMutationReason, null>, string> = {
  "not-production": "Deadline notifications are available only in the production app.",
  "authority-unavailable": "Deadline notifications are unavailable because the server Push authority could not be loaded. Check the server logs.",
  "recovery-pending": "Deadline notifications are unavailable until Draw restarts and completes Push recovery.",
  "secure-transport-required": "Open Draw over HTTPS, or directly on localhost, to manage deadline notifications.",
  "proxy-configuration-unsupported": "Draw cannot verify this proxy request for notification management. Check the deployment proxy configuration.",
};

export type PushFailureContext = "enroll" | "test" | "mutation";

export function pushFailureMessage(error: unknown, context: PushFailureContext): string {
  if (error instanceof PushNetworkError) return "Could not reach Draw. Check the connection and try again.";
  if (!(error instanceof ApiError)) return context === "enroll"
    ? "Could not enable notifications in this browser. No device was enabled."
    : "The notification request was rejected. Refresh Draw and try again.";
  const code = typeof (error.body as { error?: unknown } | undefined)?.error === "string"
    ? (error.body as { error: string }).error
    : error.message;
  if (error.status === 401) return "Your Draw session expired. Reload Draw to unlock it.";
  if (error.status === 409 && code === "push-test-cancelled") return "Test send cancelled because notification state changed";
  if ((error.status === 404 && code === "push-device-not-found") ||
    (error.status === 410 && code === "push-subscription-gone")) {
    return "This device is no longer enrolled. Choose Enable to enroll it again.";
  }
  if (error.status === 409 && code === "push-device-limit") return "Draw already has 16 enrolled devices. Revoke one, then try again.";
  if (error.status === 429 && code === "push-rate-limited") return "Too many notification requests. Wait and try again.";
  if (error.status === 503 && code === "push-busy") return "Notification service is busy. Try again.";
  if (error.status === 504 && code === "push-timeout") return "The notification request timed out. Draw does not retry automatically.";
  if (context === "enroll" && error.status === 502 && code === "push-endpoint-unavailable") {
    return "The browser push service could not be reached. No device was enabled.";
  }
  if (context === "test" && error.status === 502 && code === "push-delivery-failed") {
    return "The test was not accepted by the push service. Draw will not retry it.";
  }
  return "The notification request was rejected. Refresh Draw and try again.";
}
