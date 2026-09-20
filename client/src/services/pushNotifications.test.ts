import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  STATUS_GUIDANCE,
  PushResponseError,
  beginEnrollmentOperation,
  clearStoredHandle,
  deletePushDevice,
  decodeCanonicalBase64Url,
  encodeBase64Url,
  equalBytes,
  enrollmentPrerequisites,
  inspectBrowserPush,
  isCanonicalUuidV4,
  listedHandle,
  parsePushStatus,
  pushFailureMessage,
  registerPushSubscription,
  revokeAllPushDevices,
  samePrerequisites,
  sameSubscriptionData,
  sendPushTest,
  setPushPreference,
  setPushTiming,
  snapshotFingerprint,
  storeHandle,
  subscriptionMatches,
  type BrowserPushSnapshot,
  type EnrollmentPrerequisites,
  type PushStatus,
} from "./pushNotifications";

const DEVICE = "123e4567-e89b-42d3-a456-426614174000";
const VAPID = Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index);
const VAPID_TEXT = encodeBase64Url(VAPID);

function subscription(key = VAPID): PushSubscription {
  return {
    endpoint: "https://push.example.test/path",
    expirationTime: null,
    options: { applicationServerKey: key.buffer },
    getKey: (name: PushEncryptionKeyName) => name === "p256dh"
      ? Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index).buffer
      : Uint8Array.from({ length: 16 }, (_, index) => index).buffer,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: vi.fn(),
  } as unknown as PushSubscription;
}

function status(overrides: Partial<PushStatus> = {}): PushStatus {
  return {
    available: true,
    reason: null,
    mutationAllowed: true,
    mutationReason: null,
    vapidPublicKey: VAPID_TEXT,
    maxDevices: 16,
    preferences: {
      hideDetails: false, leadDays: 1, sendTime: "09:00", timezone: null, quietStart: null, quietEnd: null,
    },
    devices: [],
    ...overrides,
  };
}

function browser(overrides: Partial<BrowserPushSnapshot> = {}): BrowserPushSnapshot {
  const activeWorker = { state: "activated", scriptURL: "https://draw.test/sw.js" } as ServiceWorker;
  return {
    secureContext: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    permission: "granted",
    registration: { active: activeWorker } as ServiceWorkerRegistration,
    activeWorker,
    workerIdentity: "https://draw.test/\nhttps://draw.test/sw.js\nactivated",
    pushManager: { subscribe: vi.fn() } as unknown as PushManager,
    subscription: null,
    handle: null,
    malformedHandle: false,
    ...overrides,
  };
}

function prerequisites(overrides: Partial<BrowserPushSnapshot> = {}): EnrollmentPrerequisites {
  return { status: status(), browser: browser(overrides), vapidBytes: VAPID };
}

afterEach(() => vi.unstubAllGlobals());

describe("strict Push client boundary", () => {
  it("round-trips canonical unpadded base64url and compares bytes", () => {
    expect(decodeCanonicalBase64Url(VAPID_TEXT, 65)).toEqual(VAPID);
    expect(decodeCanonicalBase64Url(`${VAPID_TEXT}=`, 65)).toBeNull();
    expect(decodeCanonicalBase64Url("AA", 2)).toBeNull();
    expect(equalBytes(VAPID.buffer, VAPID)).toBe(true);
    expect(equalBytes(Uint8Array.of(1), VAPID)).toBe(false);
  });

  it("accepts only canonical lowercase UUIDv4 handles", () => {
    expect(isCanonicalUuidV4(DEVICE)).toBe(true);
    expect(isCanonicalUuidV4(DEVICE.toUpperCase())).toBe(false);
    expect(isCanonicalUuidV4("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
  });

  it("validates the complete closed status shape", () => {
    const value = status({ devices: [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z" }] });
    expect(parsePushStatus(value)).toEqual(value);
    expect(() => parsePushStatus({ ...value, secret: "no" })).toThrow("invalid Push status");
    expect(() => parsePushStatus({ ...value, available: false })).toThrow("inconsistent Push status");
    expect(() => parsePushStatus({ ...value, vapidPublicKey: "not canonical" })).toThrow("invalid Push status");
    for (const preferences of [
      { ...value.preferences, sendTime: "09:01" },
      { ...value.preferences, timezone: " UTC" },
      { ...value.preferences, quietStart: "22:00", quietEnd: null },
      { ...value.preferences, quietStart: "08:00", quietEnd: "08:00" },
      { ...value.preferences, unknown: true },
    ]) expect(() => parsePushStatus({ ...value, preferences })).toThrow("invalid Push status");
  });

  it("inspects capabilities without prompting, subscribing, mutating or writing storage", async () => {
    const active = { state: "activated", scriptURL: "https://draw.test/sw.js" } as ServiceWorker;
    const getSubscription = vi.fn(() => Promise.resolve(null));
    const getRegistration = vi.fn(() => Promise.resolve({
      scope: "https://draw.test/",
      active,
      pushManager: { getSubscription },
    }));
    const storage = {
      getItem: vi.fn(() => "malformed"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const requestPermission = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { origin: "https://draw.test" });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("PushManager", class PushManager {});
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const snapshot = await inspectBrowserPush();
    expect(snapshot).toMatchObject({
      secureContext: true,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
      permission: "default",
      activeWorker: active,
      handle: null,
      malformedHandle: true,
    });
    expect(getRegistration).toHaveBeenCalledWith("/");
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(enrollmentPrerequisites(status(), snapshot)).not.toBeNull();
  });

  it("matches subscription data rather than JavaScript wrapper identity", () => {
    const current = subscription();
    const equivalentWrapper = subscription();
    expect(current).not.toBe(equivalentWrapper);
    expect(subscriptionMatches(current, VAPID)).toBe(true);
    expect(sameSubscriptionData(current, equivalentWrapper)).toBe(true);
    expect(sameSubscriptionData(current, subscription(Uint8Array.of(1)))).toBe(false);
    const differentEndpoint = subscription();
    Object.defineProperty(differentEndpoint, "endpoint", { value: "https://push.example.test/other" });
    expect(sameSubscriptionData(current, differentEndpoint)).toBe(false);
    expect(subscriptionMatches(subscription(Uint8Array.of(1)), VAPID)).toBe(false);
    expect(subscriptionMatches({ ...current, options: { applicationServerKey: null } } as PushSubscription, VAPID)).toBe(false);
  });

  it("identifies this browser only by an exact listed local handle", () => {
    expect(listedHandle(status({ devices: [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }] }), DEVICE)).toBe(DEVICE);
    expect(listedHandle(status(), DEVICE)).toBeNull();
  });

  it("starts permission synchronously and no second sensitive operation", async () => {
    const order: string[] = [];
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(() => { order.push("permission"); return Promise.resolve("granted"); }),
    });
    const captured = prerequisites({ permission: "default" });
    const operation = beginEnrollmentOperation(captured, false);
    order.push("handler-returned");
    expect(order).toEqual(["permission", "handler-returned"]);
    expect(operation?.kind).toBe("permission");
    await operation?.promise;
    expect(captured.browser.pushManager!.subscribe).not.toHaveBeenCalled();
  });

  it("starts mismatch unsubscribe synchronously and stages replacement separately", () => {
    const old = subscription(Uint8Array.of(9));
    const operation = beginEnrollmentOperation(prerequisites({ subscription: old }), false);
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(operation?.kind).toBe("unsubscribe");
    expect(beginEnrollmentOperation(prerequisites({ subscription: old }), true)).toBeNull();
  });

  it("starts subscribe synchronously only from a granted explicit click", () => {
    const subscribe = vi.fn(() => Promise.resolve(subscription()));
    const captured = prerequisites({ pushManager: { subscribe } as unknown as PushManager });
    const operation = beginEnrollmentOperation(captured, false);
    expect(operation?.kind).toBe("subscribe");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: VAPID.buffer });
  });

  it("reuses a matching subscription without subscribe or unsubscribe", () => {
    const current = subscription();
    const captured = prerequisites({ subscription: current });
    expect(beginEnrollmentOperation(captured, false)).toBeNull();
    expect(captured.browser.pushManager!.subscribe).not.toHaveBeenCalled();
    expect(current.unsubscribe).not.toHaveBeenCalled();
  });

  it("invalidates continuation on each named prerequisite change", () => {
    const previous = prerequisites();
    expect(snapshotFingerprint(previous)).toBe(snapshotFingerprint(previous));
    const variants: EnrollmentPrerequisites[] = [
      { ...previous, browser: browser({ permission: "denied" }) },
      { ...previous, browser: browser({ workerIdentity: "new worker" }) },
      { ...previous, status: status({ available: false, reason: "recovery-pending", vapidPublicKey: null }) },
      { ...previous, status: status({ mutationAllowed: false, mutationReason: "secure-transport-required" }) },
      { ...previous, status: status({ vapidPublicKey: encodeBase64Url(Uint8Array.from({ length: 65 }, () => 2)) }) },
    ];
    for (const current of variants) expect(samePrerequisites(previous, current)).toBe(false);
    const beforePermission = { ...previous, browser: { ...previous.browser, permission: "default" as const } };
    expect(samePrerequisites(beforePermission, previous, true)).toBe(true);
  });

  it("POSTs the exact strict registration only after valid browser keys", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      device: { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    }), { status: 201, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await registerPushSubscription(subscription(), DEVICE)).id).toBe(DEVICE);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/subscriptions");
    expect(JSON.parse(String(init.body))).toEqual({
      subscription: {
        endpoint: "https://push.example.test/path",
        expirationTime: null,
        keys: {
          p256dh: encodeBase64Url(Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index)),
          auth: encodeBase64Url(Uint8Array.from({ length: 16 }, (_, index) => index)),
        },
      },
      replaceDeviceId: DEVICE,
    });
    const invalid = subscription();
    invalid.getKey = () => null;
    await expect(registerPushSubscription(invalid, null)).rejects.toThrow("invalid browser subscription");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unexpected success status", () => new Response(JSON.stringify({
      device: { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    }), { status: 202 })],
    ["unreadable success body", () => new Response("not-json", { status: 201 })],
    ["invalid success body", () => new Response(JSON.stringify({ device: { id: "not-a-device" } }), { status: 201 })],
  ])("classifies an enrollment %s as a closed API response failure", async (_name, reply) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const error = await registerPushSubscription(subscription(), null).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PushResponseError);
    expect(pushFailureMessage(error, "enroll")).toBe(
      "The notification request was rejected. Refresh Draw and try again.",
    );
  });

  it("uses exact no-body device calls, exact preference JSON and never retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hideDetails: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        leadDays: 2, sendTime: "10:15", timezone: "UTC", quietStart: null, quietEnd: null,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendPushTest(DEVICE);
    await deletePushDevice(DEVICE);
    await revokeAllPushDevices();
    expect(await setPushPreference(true)).toBe(true);
    const timing = { leadDays: 2 as const, sendTime: "10:15", timezone: "UTC", quietStart: null, quietEnd: null };
    expect(await setPushTiming(timing)).toEqual(timing);
    expect(fetchMock.mock.calls).toEqual([
      [`/api/push/subscriptions/${DEVICE}/test`, { method: "POST" }],
      [`/api/push/subscriptions/${DEVICE}`, { method: "DELETE" }],
      ["/api/push/subscriptions", { method: "DELETE" }],
      ["/api/push/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hideDetails: true }) }],
      ["/api/push/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(timing) }],
    ]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "push-rate-limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    }));
    await expect(sendPushTest(DEVICE)).rejects.toMatchObject({ status: 429, message: "push-rate-limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists and conditionally clears only canonical handles", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    expect(storeHandle(DEVICE)).toBe(true);
    expect(clearStoredHandle("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(values.size).toBe(1);
    expect(clearStoredHandle(DEVICE)).toBe(true);
    expect(values.size).toBe(0);
    expect(storeHandle("bad")).toBe(false);
  });

  it("fails storage closed under throws and read-back tampering", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "tampered"),
      setItem: vi.fn(),
      removeItem: vi.fn(() => { throw new Error("denied"); }),
    });
    expect(storeHandle(DEVICE)).toBe(false);
    expect(clearStoredHandle()).toBe(false);
  });

  it("keeps all server availability and topology guidance fixed and password-free", () => {
    expect(STATUS_GUIDANCE).toEqual({
      "not-production": "Deadline notifications are available only in the production app.",
      "authority-unavailable": "Deadline notifications are unavailable because the server Push authority could not be loaded. Check the server logs.",
      "recovery-pending": "Deadline notifications are unavailable until Draw restarts and completes Push recovery.",
      "secure-transport-required": "Open Draw over HTTPS, or directly on localhost, to manage deadline notifications.",
      "proxy-configuration-unsupported": "Draw cannot verify this proxy request for notification management. Check the deployment proxy configuration.",
    });
    expect(JSON.stringify(STATUS_GUIDANCE)).not.toContain("password");
  });

  it("maps every closed failure without exposing response detail or retrying", () => {
    const cases: Array<[number, string, "enroll" | "test" | "mutation", string]> = [
      [409, "push-test-cancelled", "test", "Test send cancelled because notification state changed"],
      [404, "push-device-not-found", "test", "This device is no longer enrolled. Choose Enable to enroll it again."],
      [410, "push-subscription-gone", "test", "This device is no longer enrolled. Choose Enable to enroll it again."],
      [409, "push-device-limit", "enroll", "Draw already has 16 enrolled devices. Revoke one, then try again."],
      [429, "push-rate-limited", "test", "Too many notification requests. Wait and try again."],
      [503, "push-busy", "test", "Notification service is busy. Try again."],
      [504, "push-timeout", "test", "The notification request timed out. Draw does not retry automatically."],
      [502, "push-endpoint-unavailable", "enroll", "The browser push service could not be reached. No device was enabled."],
      [502, "push-delivery-failed", "test", "The test was not accepted by the push service. Draw will not retry it."],
      [401, "anything-secret", "test", "Your Draw session expired. Reload Draw to unlock it."],
      [400, "invalid-push-request", "enroll", "The notification request was rejected. Refresh Draw and try again."],
      [413, "push-body-too-large", "mutation", "The notification request was rejected. Refresh Draw and try again."],
      [415, "push-json-required", "enroll", "The notification request was rejected. Refresh Draw and try again."],
      [418, "unknown-closed-code", "enroll", "The notification request was rejected. Refresh Draw and try again."],
    ];
    for (const [statusCode, code, context, expected] of cases) {
      expect(pushFailureMessage(new ApiError(statusCode, code, { error: code }), context)).toBe(expected);
    }
  });
});
