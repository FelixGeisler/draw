import { devices, expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import webPush from "web-push";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const PROD = `http://127.0.0.1:${process.env.E2E_PROD_PORT || "3102"}`;
const DEVICE = "123e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const { defaultBrowserType: _defaultBrowserType, ...PIXEL_7 } = devices["Pixel 7"];
const VAPID_PUBLIC_KEY = "B" + "A".repeat(86);

interface SyntheticStatus {
  available: boolean;
  reason: null | "not-production" | "authority-unavailable" | "recovery-pending";
  mutationAllowed: boolean;
  mutationReason: null | "secure-transport-required" | "proxy-configuration-unsupported";
  vapidPublicKey: string | null;
  maxDevices: 16;
  preferences: ReturnType<typeof timingPreferences>;
  devices: Array<{ id: string; createdAt: string; lastSeenAt: string }>;
}

function timingPreferences(hideDetails = false) {
  return { hideDetails, leadDays: 1 as 0 | 1 | 2 | 3 | 7 | 14 | 30, sendTime: "09:00", timezone: null as string | null,
    quietStart: null as string | null, quietEnd: null as string | null };
}

function syntheticStatus(overrides: Partial<SyntheticStatus> = {}): SyntheticStatus {
  return {
    available: true,
    reason: null,
    mutationAllowed: true,
    mutationReason: null,
    vapidPublicKey: VAPID_PUBLIC_KEY,
    maxDevices: 16,
    preferences: timingPreferences(),
    devices: [],
    ...overrides,
  };
}

interface WorkerHarness {
  listeners: Map<string, (event: any) => void>;
  notifications: Array<{ title: string; options: Record<string, unknown> }>;
  cacheCalls: string[];
  clients: any[];
  opened: string[];
}

function executeWorker(source: string, origin = "https://draw.test"): WorkerHarness {
  const listeners = new Map<string, (event: any) => void>();
  const notifications: WorkerHarness["notifications"] = [];
  const cacheCalls: string[] = [];
  const clients: any[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin },
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url); return null; },
    },
    skipWaiting: async () => undefined,
  };
  const caches = {
    open: async () => { cacheCalls.push("open"); return { addAll: async () => undefined, put: async () => undefined }; },
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
  };
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: async () => new Response(),
    Response,
    URL,
    Blob,
    TextDecoder,
    Promise,
    atob,
    btoa,
  }, { filename: "production-served-sw.js" });
  return { listeners, notifications, cacheCalls, clients, opened };
}

async function dispatchPush(harness: WorkerHarness, value?: unknown, raw?: Uint8Array) {
  let completion: Promise<unknown> | null = null;
  const bytes = raw ?? new TextEncoder().encode(JSON.stringify(value));
  harness.listeners.get("push")!({
    data: value === undefined && raw === undefined ? null : { blob: () => new Blob([bytes]) },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; },
  });
  await completion;
}

async function dispatchClick(harness: WorkerHarness, data: unknown) {
  let completion: Promise<unknown> | null = null;
  const order: string[] = [];
  harness.listeners.get("notificationclick")!({
    notification: { data, close: () => order.push("close") },
    waitUntil: (promise: Promise<unknown>) => { order.push("waitUntil"); completion = promise; },
  });
  if (completion) await completion;
  return order;
}

test.describe("production-served closed Push worker protocol", () => {
  let source: string;

  test.beforeAll(async ({ request }) => {
    const response = await request.get(`${PROD}/sw.js`);
    expect(response.ok()).toBeTruthy();
    source = await response.text();
    expect(source).toContain('const CACHE = "draw-shell-v4"');
  });

  test("renders only the exact test, generic and detailed schemas", async () => {
    const worker = executeWorker(source);
    await dispatchPush(worker, { v: 1, kind: "test" });
    await dispatchPush(worker, { v: 1, kind: "deadline", detail: "generic", itemType: "task", itemId: 7, eventId: EVENT_ID });
    await dispatchPush(worker, { v: 1, kind: "deadline", detail: "detailed", itemType: "goal", itemId: 9, eventId: EVENT_ID, itemTitle: "Finish <paper>", context: "Study", deadline: "2026-12-31" });
    await dispatchPush(worker, { v: 1, kind: "deadline", detail: "detailed", itemType: "task", itemId: 10, eventId: EVENT_ID, itemTitle: "Submit", context: null, deadline: "2028-02-29" });

    expect(worker.notifications).toEqual([
      { title: "Draw", options: { body: "Notifications are enabled", tag: "draw-push-test", data: { v: 1, route: "/settings" } } },
      { title: "Draw", options: { body: "You have an upcoming deadline in Draw", tag: `draw-deadline-${EVENT_ID}`, data: { v: 1, route: "/tasks?focus=7&showDone=1" } } },
      { title: "Finish <paper>", options: { body: "Study · Due 2026-12-31", tag: `draw-deadline-${EVENT_ID}`, data: { v: 1, route: "/goals?focus=9" } } },
      { title: "Submit", options: { body: "Due 2028-02-29", tag: `draw-deadline-${EVENT_ID}`, data: { v: 1, route: "/tasks?focus=10&showDone=1" } } },
    ]);
    for (const notification of worker.notifications) {
      expect(notification.options).not.toHaveProperty("icon");
      expect(notification.options).not.toHaveProperty("image");
      expect(notification.options).not.toHaveProperty("actions");
      expect(notification.options).not.toHaveProperty("url");
    }
    expect(worker.cacheCalls).toEqual([]);
  });

  test("rejects absent, malformed, oversized, unknown, extra and noncanonical payloads", async () => {
    const worker = executeWorker(source);
    await dispatchPush(worker);
    await dispatchPush(worker, undefined, Uint8Array.of(0xff));
    await dispatchPush(worker, undefined, new Uint8Array(3_073));
    const rejected = [
      null,
      [],
      { v: 2, kind: "test" },
      { v: 1, kind: "test", extra: true },
      { v: 1, kind: "deadline", detail: "generic", itemType: "task", itemId: 0, eventId: EVENT_ID },
      { v: 1, kind: "deadline", detail: "generic", itemType: "task", itemId: 1.5, eventId: EVENT_ID },
      { v: 1, kind: "deadline", detail: "generic", itemType: "other", itemId: 1, eventId: EVENT_ID },
      { v: 1, kind: "deadline", detail: "generic", itemType: "goal", itemId: 1, eventId: "AAAAAAAAAAAAAAAAAAAAAB" },
      { v: 1, kind: "deadline", detail: "generic", itemType: "goal", itemId: 1, eventId: `${EVENT_ID}= ` },
      { v: 1, kind: "deadline", detail: "detailed", itemType: "goal", itemId: 1, eventId: EVENT_ID, itemTitle: "x", context: null, deadline: "2026-02-30" },
      { v: 1, kind: "deadline", detail: "detailed", itemType: "goal", itemId: 1, eventId: EVENT_ID, itemTitle: "x", context: 4, deadline: "2026-01-01" },
      { v: 1, kind: "deadline", detail: "detailed", itemType: "goal", itemId: 1, eventId: EVENT_ID, itemTitle: "x", context: null, deadline: "2026-1-01" },
      { v: 1, kind: "deadline", detail: "generic", itemType: "goal", itemId: 1, eventId: EVENT_ID, url: "https://evil.test" },
    ];
    for (const payload of rejected) await dispatchPush(worker, payload);
    expect(worker.notifications).toEqual([]);
    expect(worker.cacheCalls).toEqual([]);
  });

  test("closes first, navigates and focuses the first same-origin window", async () => {
    const worker = executeWorker(source);
    const calls: string[] = [];
    worker.clients.push(
      { url: "https://elsewhere.test/", navigate: viNever, focus: viNever },
      { url: "https://draw.test/old", navigate: async (url: string) => { calls.push(`navigate:${url}`); }, focus: async () => { calls.push("focus"); } },
      { url: "https://draw.test/second", navigate: viNever, focus: viNever },
    );
    expect(await dispatchClick(worker, { v: 1, route: "/tasks?focus=7&showDone=1" })).toEqual(["close", "waitUntil"]);
    expect(calls).toEqual(["navigate:https://draw.test/tasks?focus=7&showDone=1", "focus"]);
    expect(worker.opened).toEqual([]);
  });

  test("opens a canonical same-origin route when no same-origin window exists", async () => {
    const worker = executeWorker(source);
    worker.clients.push({ url: "https://elsewhere.test/" });
    await dispatchClick(worker, { v: 1, route: "/goals?focus=3" });
    expect(worker.opened).toEqual(["https://draw.test/goals?focus=3"]);
  });

  test("rejects every noncanonical or attacker-controlled click route after closing", async () => {
    const rejected = [
      "https://draw.test/settings", "//evil.test/settings", "/settings?x=1", "/settings#x",
      "/tasks?showDone=1&focus=1", "/tasks?focus=1", "/tasks?focus=1&showDone=1&x=1",
      "/tasks?focus=1&focus=2&showDone=1", "/tasks?focus=%31&showDone=1",
      "/tasks?focus=+1&showDone=1", "/tasks?focus=0&showDone=1", "/tasks?focus=01&showDone=1",
      "/tasks?focus=1.0&showDone=1", "/tasks?focus=1e2&showDone=1", "/tasks?focus=9007199254740992&showDone=1",
      "/goals?focus=%31", "/goals?focus=1#x", "/goals?focus=1&x=2",
    ];
    for (const route of rejected) {
      const worker = executeWorker(source);
      expect(await dispatchClick(worker, { v: 1, route }), route).toEqual(["close"]);
      expect(worker.opened, route).toEqual([]);
    }
    const extra = executeWorker(source);
    expect(await dispatchClick(extra, { v: 1, route: "/settings", extra: true })).toEqual(["close"]);
  });
});

async function viNever(): Promise<never> {
  throw new Error("unexpected client call");
}

async function installSyntheticPushBrowser(page: Page) {
  await page.addInitScript(() => {
    const fakeSubscription = null;
    const active = { state: "activated", scriptURL: `${location.origin}/sw.js` };
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted", requestPermission: () => { throw new Error("must not prompt during inspection"); } },
    });
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      configurable: true,
      value: async () => ({
        scope: `${location.origin}/`,
        active,
        pushManager: {
          getSubscription: async () => fakeSubscription,
          subscribe: () => { throw new Error("real enrollment is forbidden in E2E"); },
        },
      }),
    });
  });
}

async function installStagedSyntheticPushBrowser(page: Page) {
  await page.addInitScript(() => {
    let permission: NotificationPermission = "default";
    let current: PushSubscription | null = null;
    const events: string[] = [];
    Object.defineProperty(globalThis, "__pushEvents", { value: events });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        get permission() { return permission; },
        requestPermission: () => {
          events.push("permission");
          permission = "granted";
          return Promise.resolve(permission);
        },
      },
    });
    const publicKey = Uint8Array.from(atob("B" + "A".repeat(86) + "="), (character) => character.charCodeAt(0));
    const active = { state: "activated", scriptURL: `${location.origin}/sw.js` };
    const subscription = {
      endpoint: "https://push.example.test/stage-1c-synthetic",
      expirationTime: null,
      options: { applicationServerKey: publicKey.buffer },
      getKey: (name: string) => name === "p256dh"
        ? Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index).buffer
        : Uint8Array.from({ length: 16 }, (_, index) => index).buffer,
      unsubscribe: () => { events.push("unsubscribe"); current = null; return Promise.resolve(true); },
    };
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      configurable: true,
      value: async () => ({
        scope: `${location.origin}/`,
        active,
        pushManager: {
          getSubscription: async () => current,
          subscribe: () => { events.push("subscribe"); current = subscription as unknown as PushSubscription; return Promise.resolve(current); },
        },
      }),
    });
  });
}

async function installDeferredSyntheticPushBrowser(page: Page) {
  await page.addInitScript(() => {
    const events: string[] = [];
    let current: PushSubscription | null = null;
    let resolveSubscribe: ((value: PushSubscription) => void) | null = null;
    Object.defineProperty(globalThis, "__pushEvents", { value: events });
    Object.defineProperty(globalThis, "__resolvePushSubscribe", {
      value: () => {
        current = subscription as unknown as PushSubscription;
        resolveSubscribe?.(current);
      },
    });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted", requestPermission: () => { throw new Error("unexpected permission request"); } },
    });
    const publicKey = Uint8Array.from(atob("B" + "A".repeat(86) + "="), (character) => character.charCodeAt(0));
    const active = { state: "activated", scriptURL: `${location.origin}/sw.js` };
    const subscription = {
      endpoint: "https://push.example.test/deferred-synthetic",
      expirationTime: null,
      options: { applicationServerKey: publicKey.buffer },
      getKey: (name: string) => name === "p256dh"
        ? Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index).buffer
        : Uint8Array.from({ length: 16 }, (_, index) => index).buffer,
      unsubscribe: () => { events.push("unsubscribe"); current = null; return Promise.resolve(true); },
    };
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      configurable: true,
      value: async () => ({
        scope: `${location.origin}/`, active,
        pushManager: {
          getSubscription: async () => current,
          subscribe: () => {
            events.push("subscribe");
            return new Promise<PushSubscription>((resolve) => { resolveSubscribe = resolve; });
          },
        },
      }),
    });
  });
}

type ControlledBrowserOptions = {
  permission?: NotificationPermission;
  subscription?: "none" | "matching" | "mismatch";
  failStorageSet?: boolean;
  failStorageRemove?: boolean;
  unsubscribeResult?: boolean;
  storedHandle?: string | null;
};

async function installControlledSyntheticPushBrowser(
  page: Page,
  options: ControlledBrowserOptions = {},
) {
  await page.addInitScript((initial) => {
    type SubscriptionRecord = { endpoint: string; key: Uint8Array };
    const events: string[] = [];
    let permission: NotificationPermission = initial.permission ?? "granted";
    const matchingKey = Uint8Array.from(atob("B" + "A".repeat(86) + "="), (character) => character.charCodeAt(0));
    const mismatchKey = Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : 9);
    let current: SubscriptionRecord | null = initial.subscription === "matching"
      ? { endpoint: "https://push.example.test/controlled", key: matchingKey }
      : initial.subscription === "mismatch"
        ? { endpoint: "https://push.example.test/old", key: mismatchKey }
        : null;
    const firstWorker = { state: "activated", scriptURL: `${location.origin}/sw.js` };
    const replacementWorker = { state: "activated", scriptURL: `${location.origin}/sw.js` };
    let activeWorker = firstWorker;

    const makeSubscription = (record: SubscriptionRecord): PushSubscription => ({
      endpoint: record.endpoint,
      expirationTime: null,
      options: { applicationServerKey: record.key.buffer, userVisibleOnly: true },
      getKey: (name: PushEncryptionKeyName) => name === "p256dh"
        ? Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index).buffer
        : Uint8Array.from({ length: 16 }, (_, index) => index).buffer,
      unsubscribe: () => {
        events.push("unsubscribe");
        if (initial.unsubscribeResult === false) return Promise.resolve(false);
        current = null;
        return Promise.resolve(true);
      },
      toJSON: () => ({}),
    } as PushSubscription);

    const control = {
      events,
      setPermission: (value: NotificationPermission) => { permission = value; },
      replaceWorkerAtSameUrl: () => { activeWorker = replacementWorker; },
      record: (value: string) => events.push(value),
    };
    Object.defineProperty(globalThis, "__pushControl", { configurable: true, value: control });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        get permission() { return permission; },
        requestPermission: () => {
          events.push("permission");
          permission = "granted";
          return Promise.resolve(permission);
        },
      },
    });
    const registration = {
      scope: `${location.origin}/`,
      get active() { return activeWorker; },
      pushManager: {
        // Deliberately return a distinct standards-equivalent wrapper on every
        // read. Product code must identify the subscription by exact data.
        getSubscription: async () => current ? makeSubscription(current) : null,
        subscribe: () => {
          events.push("subscribe");
          current = { endpoint: "https://push.example.test/controlled", key: matchingKey };
          return Promise.resolve(makeSubscription(current));
        },
      },
    };
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      configurable: true,
      value: async () => registration,
    });

    const nativeSet = Storage.prototype.setItem;
    const nativeRemove = Storage.prototype.removeItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        if (key === "draw.push.device.v1" && initial.failStorageSet) throw new Error("synthetic storage set failure");
        return nativeSet.call(this, key, value);
      },
    });
    Object.defineProperty(Storage.prototype, "removeItem", {
      configurable: true,
      value(this: Storage, key: string) {
        if (key === "draw.push.device.v1") events.push("storage-remove");
        if (key === "draw.push.device.v1" && initial.failStorageRemove) throw new Error("synthetic storage remove failure");
        return nativeRemove.call(this, key);
      },
    });
    if (initial.storedHandle !== undefined && initial.storedHandle !== null) {
      nativeSet.call(localStorage, "draw.push.device.v1", initial.storedHandle);
    }
  }, options);
}

async function pushEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (
    globalThis as typeof globalThis & { __pushControl: { events: string[] } }
  ).__pushControl.events.slice());
}

async function recordPushEvent(page: Page, value: string) {
  await page.evaluate((event) => (
    globalThis as typeof globalThis & { __pushControl: { record: (entry: string) => void } }
  ).__pushControl.record(event), value);
}

async function exerciseSyntheticSettings(page: Page) {
  let preferences = timingPreferences();
  let putBody: unknown = null;
  await page.route("**/api/push/status", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      available: true,
      reason: null,
      mutationAllowed: true,
      mutationReason: null,
      vapidPublicKey: "B" + "A".repeat(86),
      maxDevices: 16,
      preferences,
      devices: [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z" }],
    }),
  }));
  await page.route("**/api/push/preferences", async (route) => {
    putBody = route.request().postDataJSON();
    if ("hideDetails" in (putBody as Record<string, unknown>)) {
      preferences = { ...preferences, hideDetails: (putBody as { hideDetails: boolean }).hideDetails };
    } else {
      preferences = { ...preferences, ...(putBody as Omit<typeof preferences, "hideDetails">) };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(putBody) });
  });
  await installSyntheticPushBrowser(page);
  await page.goto(`${PROD}/settings`);
  await expect(page.getByRole("heading", { name: "Deadline notifications" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable" })).toBeVisible();
  await expect(page.getByText("Other device")).toBeVisible();
  const preference = page.getByRole("checkbox", { name: "Hide notification details" });
  // The controlled checkbox intentionally keeps the prior server value while
  // the PUT is pending; click (rather than check's immediate-state contract),
  // then observe the authoritative refetch.
  await preference.click();
  await expect(preference).toBeChecked();
  expect(putBody).toEqual({ hideDetails: true });

  await page.getByLabel("Remind me").selectOption("2");
  await page.getByLabel("Send time").fill("10:15");
  await page.getByLabel("Time zone (IANA)").fill("UTC");
  await page.getByRole("checkbox", { name: "Quiet hours" }).check();
  await page.getByLabel("Start").fill("21:00");
  await page.getByLabel("End", { exact: true }).fill("07:30");
  await page.getByRole("button", { name: "Save reminder timing" }).click();
  await expect(page.getByText("Reminder timing saved.")).toBeVisible();
  expect(putBody).toEqual({ leadDays: 2, sendTime: "10:15", timezone: "UTC", quietStart: "21:00", quietEnd: "07:30" });
  const panel = page.locator(".push-notifications");
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.describe("production durable Push landings", () => {
  test("reveals a done task, clears work mode, consumes owned URL fields and flashes the row", async ({ page }) => {
    const categoriesResponse = await page.request.get(`${PROD}/api/categories`);
    expect(categoriesResponse.ok()).toBeTruthy();
    const categories = await categoriesResponse.json() as Array<{ id: number }>;
    expect(categories.length).toBeGreaterThan(1);
    const created = await page.request.post(`${PROD}/api/tasks`, {
      data: { title: "Stage 1C synthetic landing task", categoryId: categories[0].id },
    });
    expect(created.ok()).toBeTruthy();
    const task = await created.json() as { id: number };
    try {
      expect((await page.request.patch(`${PROD}/api/tasks/${task.id}`, { data: { status: "done" } })).ok()).toBeTruthy();
      await page.addInitScript((scope) => localStorage.setItem("draw.deckScope", String(scope)), categories[1].id);
      await page.goto(`${PROD}/tasks?keep=before&focus=${task.id}&showDone=1&tail=after#landing`);
      await expect(page).toHaveURL(`${PROD}/tasks?keep=before&tail=after#landing`);
      await expect(page.getByRole("checkbox", { name: "show done" })).toBeChecked();
      const row = page.locator(`[data-task-id="${task.id}"]`).first();
      await expect(row).toBeVisible();
      await expect(row).toHaveClass(/palette-flash/);
      await expect.poll(() => page.evaluate(() => localStorage.getItem("draw.deckScope"))).toBeNull();
    } finally {
      expect((await page.request.delete(`${PROD}/api/tasks/${task.id}`)).ok()).toBeTruthy();
    }
  });

  test("consumes a goal focus while preserving unrelated query and hash", async ({ page }) => {
    const created = await page.request.post(`${PROD}/api/goals`, {
      data: { title: "Stage 1C synthetic landing goal" },
    });
    expect(created.ok()).toBeTruthy();
    const goal = await created.json() as { id: number };
    try {
      await page.goto(`${PROD}/goals?before=1&focus=${goal.id}&after=2#landing`);
      await expect(page).toHaveURL(`${PROD}/goals?before=1&after=2#landing`);
      const card = page.locator(`[data-goal-id="${goal.id}"]`);
      await expect(card).toBeVisible();
      await expect(card).toHaveClass(/palette-flash/);
    } finally {
      expect((await page.request.delete(`${PROD}/api/goals/${goal.id}`)).ok()).toBeTruthy();
    }
  });

  test("invalid focus degrades quietly and never falls back to palette state", async ({ page }) => {
    await page.goto(`${PROD}/tasks?focus=%31&showDone=1&keep=yes#invalid`);
    await expect(page).toHaveURL(`${PROD}/tasks?keep=yes#invalid`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  });

  test("absent and archived task targets degrade quietly after consuming the focused URL", async ({ page }) => {
    await page.goto(`${PROD}/tasks?focus=900719925&showDone=1&keep=absent#quiet`);
    await expect(page).toHaveURL(`${PROD}/tasks?keep=absent#quiet`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    const categories = await (await page.request.get(`${PROD}/api/categories`)).json() as Array<{ id: number }>;
    const created = await page.request.post(`${PROD}/api/tasks`, {
      data: { title: "Archived Push landing", categoryId: categories[0].id },
    });
    const task = await created.json() as { id: number };
    expect((await page.request.patch(`${PROD}/api/tasks/${task.id}`, { data: { status: "archived" } })).ok()).toBeTruthy();
    await page.goto(`${PROD}/tasks?focus=${task.id}&showDone=1`);
    await expect(page).toHaveURL(`${PROD}/tasks`);
    await expect(page.locator(`[data-task-id="${task.id}"]`).first()).not.toHaveClass(/palette-flash/);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("resolved and deleted goal targets degrade quietly after consuming the focused URL", async ({ page }) => {
    const createGoal = async (title: string) => {
      const response = await page.request.post(`${PROD}/api/goals`, { data: { title } });
      expect(response.ok()).toBeTruthy();
      return response.json() as Promise<{ id: number }>;
    };
    const resolved = await createGoal("Resolved Push landing");
    expect((await page.request.patch(`${PROD}/api/goals/${resolved.id}`, { data: { status: "achieved" } })).ok()).toBeTruthy();
    await page.goto(`${PROD}/goals?focus=${resolved.id}&keep=resolved#quiet`);
    await expect(page).toHaveURL(`${PROD}/goals?keep=resolved#quiet`);
    await expect(page.locator(`[data-goal-id="${resolved.id}"]`)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    const deleted = await createGoal("Deleted Push landing");
    expect((await page.request.delete(`${PROD}/api/goals/${deleted.id}`)).ok()).toBeTruthy();
    await page.goto(`${PROD}/goals?focus=${deleted.id}`);
    await expect(page).toHaveURL(`${PROD}/goals`);
    await expect(page.locator(`[data-goal-id="${deleted.id}"]`)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("password-gated production Push landing", () => {
  test("retains the exact focused deep link through unlock, then consumes it", async ({ page }) => {
    const port = process.env.E2E_PUSH_AUTH_PORT || "34604";
    const base = `http://127.0.0.1:${port}`;
    const password = "push-landing-e2e-password";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-e2e-push-auth-"));
    const server = spawn(process.execPath, [path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), "src/prod.ts"], {
      cwd: path.resolve(__dirname, "..", "server"),
      env: { ...process.env, DATA_DIR: dataDir, API_PORT: port, HOST: "", DRAW_PASSWORD: password, ANTHROPIC_API_KEY: "" },
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 60_000;
      for (;;) {
        try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* wait */ }
        if (server.exitCode !== null) throw new Error(`Push auth server exited early (${server.exitCode})`);
        if (Date.now() > deadline) throw new Error("Push auth server did not become healthy");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const headers = { "content-type": "application/json", "x-draw-password": password };
      const categories = await (await fetch(`${base}/api/categories`, { headers })).json() as Array<{ id: number }>;
      const created = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Password-gated Push landing", categoryId: categories[0].id }),
      });
      expect(created.ok).toBeTruthy();
      const task = await created.json() as { id: number };

      const focused = `${base}/tasks?focus=${task.id}&showDone=1&keep=auth#landing`;
      const response = await page.goto(focused);
      expect(response?.status()).toBe(401);
      await expect(page).toHaveURL(focused);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(page).toHaveURL(`${base}/tasks?keep=auth#landing`);
      const row = page.locator(`[data-task-id="${task.id}"]`).first();
      await expect(row).toBeVisible();
      await expect(row).toHaveClass(/palette-flash/);
    } finally {
      if (server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* OS cleanup */ }
    }
  });
});

test.describe("Deadline notification composed production journey", () => {
  test("flows from typed timing and a real task through the production scheduler and built worker landing", async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-deadline-composed-"));
    const moduleData = path.join(root, "module-data");
    const assemblyData = path.join(root, "assembly-data");
    fs.mkdirSync(moduleData);
    fs.mkdirSync(assemblyData);
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = moduleData;
    const [{ startProduction }, dbModule] = await Promise.all([
      import("../server/src/prod.js"),
      import("../server/src/db.js"),
    ]);
    const database = dbModule.db;
    const captured: Buffer[] = [];
    let providerRequests = 0;
    const keys = webPush.generateVAPIDKeys();
    const assembly = startProduction({
      database,
      dataDir: assemblyData,
      clientDir: path.resolve("client/dist"),
      host: "127.0.0.1",
      port: 0,
      env: { BACKUP_INTERVAL_HOURS: "0", UPDATE_CHECK_INTERVAL_HOURS: "0" },
      deadlineNow: () => new Date("2026-09-20T09:00:00Z"),
      deadlineTimer: { set: () => ({ unref() {} }), clear() {} },
      resolverFactory: () => ({
        resolve4: async () => ["8.8.8.8"],
        resolve6: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); },
        cancel() {},
      }),
      pushTransport: { send: async () => { providerRequests += 1; return "success"; } },
      observeDeadlinePayload: (payload) => captured.push(payload),
    });
    try {
      await new Promise<void>((resolve) => assembly.server.listening ? resolve() : assembly.server.once("listening", resolve));
      const address = assembly.server.address();
      if (!address || typeof address === "string") throw new Error("missing composed listener");
      const origin = `http://localhost:${address.port}`;
      const mutation = { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" };
      const status = await (await fetch(`${origin}/api/push/status`)).json() as { vapidPublicKey: string };
      expect(status.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

      const timing = { leadDays: 0, sendTime: "09:00", timezone: "UTC", quietStart: null, quietEnd: null };
      expect(await (await fetch(`${origin}/api/push/preferences`, {
        method: "PUT", headers: mutation, body: JSON.stringify(timing),
      })).json()).toEqual(timing);
      const categories = await (await fetch(`${origin}/api/categories`)).json() as Array<{ id: number }>;
      const created = await (await fetch(`${origin}/api/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Composed deadline", categoryId: categories[0].id, dueDate: "2026-09-20" }),
      })).json() as { id: number };
      const enrolled = await fetch(`${origin}/api/push/subscriptions`, {
        method: "POST", headers: mutation,
        body: JSON.stringify({ subscription: {
          endpoint: "https://push.example/composed", expirationTime: null,
          keys: { p256dh: keys.publicKey, auth: crypto.randomBytes(16).toString("base64url") },
        } }),
      });
      expect(enrolled.status).toBe(201);

      expect(database.prepare("SELECT due_date AS dueDate,status FROM tasks WHERE id=?").get(created.id))
        .toEqual({ dueDate: "2026-09-20", status: "open" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get()).toEqual({ count: 1 });
      await assembly.deadlineScheduler?.runNow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM deadline_reminder_claims").get()).toEqual({ count: 1 });
      expect(providerRequests).toBe(1);
      expect(captured).toHaveLength(1);
      const payload = JSON.parse(captured[0].toString("utf8"));
      expect(payload).toMatchObject({
        v: 1, kind: "deadline", detail: "detailed", itemType: "task", itemId: created.id,
        itemTitle: "Composed deadline", deadline: "2026-09-20",
      });

      const workerSource = await (await fetch(`${origin}/sw.js`)).text();
      const worker = executeWorker(workerSource, origin);
      await dispatchPush(worker, payload);
      expect(worker.notifications).toHaveLength(1);
      expect(worker.notifications[0]).toMatchObject({ title: "Composed deadline" });
      await dispatchClick(worker, worker.notifications[0].options.data);
      expect(worker.opened).toEqual([`${origin}/tasks?focus=${created.id}&showDone=1`]);
      await page.goto(worker.opened[0]);
      await expect(page.locator(`[data-task-id="${created.id}"]`).first()).toHaveClass(/palette-flash/);
    } finally {
      assembly.deadlineScheduler?.stop();
      await new Promise<void>((resolve) => assembly.server.close(() => resolve()));
      database.close();
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe("Deadline notification Settings — desktop production build", () => {
  test.use({ viewport: { width: 1080, height: 800 } });
  test("uses synthetic browser/API seams without real enrollment", async ({ page }) => {
    await exerciseSyntheticSettings(page);
  });

  test("shows every applicable capability, authority and transport blocker without password advice", async ({ page }) => {
    await page.route("**/api/push/status", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        reason: "authority-unavailable",
        mutationAllowed: false,
        mutationReason: "secure-transport-required",
        vapidPublicKey: null,
        maxDevices: 16,
        preferences: timingPreferences(),
        devices: [],
      }),
    }));
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false });
      Object.defineProperty(globalThis, "PushManager", { configurable: true, value: undefined });
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
      Object.defineProperty(navigator.serviceWorker, "getRegistration", { configurable: true, value: async () => undefined });
    });
    await page.goto(`${PROD}/settings`);
    const panel = page.locator(".push-notifications");
    for (const text of [
      "Deadline notifications require HTTPS, or direct localhost access.",
      "The Draw service worker is not available in this browser. Reload the production app and try again.",
      "This browser does not support Web Push.",
      "This browser does not support notifications.",
      "Deadline notifications are unavailable because the server Push authority could not be loaded. Check the server logs.",
      "Open Draw over HTTPS, or directly on localhost, to manage deadline notifications.",
    ]) await expect(panel.getByText(text)).toBeVisible();
    await expect(panel).not.toContainText("DRAW_PASSWORD");
    await expect(panel).not.toContainText("set a password");
  });

  test("offers a fixed Retry after a closed status/network failure", async ({ page }) => {
    await page.route("**/api/push/status", (route) => route.abort());
    await page.goto(`${PROD}/settings`);
    const panel = page.locator(".push-notifications");
    await expect(panel).toContainText("Could not load deadline notification status. Check the connection and try again.");
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("stages permission and subscription across explicit clicks before one enrollment POST", async ({ page }) => {
    let enrolled = false;
    let posts = 0;
    await page.route("**/api/push/status", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        reason: null,
        mutationAllowed: true,
        mutationReason: null,
        vapidPublicKey: "B" + "A".repeat(86),
        maxDevices: 16,
        preferences: timingPreferences(),
        devices: enrolled ? [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }] : [],
      }),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["subscription"]);
      enrolled = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ device: { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" } }),
      });
    });
    await installStagedSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue enabling" })).toBeVisible();
    expect(posts).toBe(0);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __pushEvents: string[] }).__pushEvents)).toEqual(["permission"]);

    await page.getByRole("button", { name: "Continue enabling" }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __pushEvents: string[] }).__pushEvents)).toEqual(["permission", "subscribe"]);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
  });

  test("POSTs a newly subscribed browser when PushManager returns an equivalent distinct wrapper", async ({ page }) => {
    let enrolled = false;
    let posts = 0;
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({
        devices: enrolled ? [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }] : [],
      })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      enrolled = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ device: { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" } }),
      });
    });
    await installControlledSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(await pushEvents(page)).toEqual(["subscribe"]);
  });

  test("a same-URL active-worker replacement prevents every activation-sensitive operation", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus()),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() === "POST") posts++;
      await route.abort();
    });
    await installControlledSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
    await page.evaluate(() => (
      globalThis as typeof globalThis & { __pushControl: { replaceWorkerAtSameUrl: () => void } }
    ).__pushControl.replaceWorkerAtSameUrl());
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect.poll(() => pushEvents(page)).toEqual([]);
    expect(posts).toBe(0);
  });

  test("unmount during a pending synthetic subscription cleans the new orphan and never POSTs", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/push/status", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        available: true, reason: null, mutationAllowed: true, mutationReason: null,
        vapidPublicKey: "B" + "A".repeat(86), maxDevices: 16,
        preferences: timingPreferences(), devices: [],
      }),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() === "POST") posts++;
      await route.abort();
    });
    await installDeferredSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __pushEvents: string[] }).__pushEvents)).toEqual(["subscribe"]);
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await page.evaluate(() => (globalThis as typeof globalThis & { __resolvePushSubscribe: () => void }).__resolvePushSubscribe());
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __pushEvents: string[] }).__pushEvents)).toEqual(["subscribe", "unsubscribe"]);
    expect(posts).toBe(0);
  });

  test("replaces a VAPID-mismatched subscription only across two explicit clicks", async ({ page }) => {
    let posts = 0;
    let postBody: Record<string, unknown> | null = null;
    let enrolled = false;
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ devices: enrolled ? [listedDevice] : [listedDevice] })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      postBody = route.request().postDataJSON() as Record<string, unknown>;
      enrolled = true;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: listedDevice }) });
    });
    await installControlledSyntheticPushBrowser(page, { subscription: "mismatch", storedHandle: DEVICE });
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Re-enable" }).click();
    await expect(page.getByRole("button", { name: "Continue enabling" })).toBeVisible();
    expect(posts).toBe(0);
    expect(await pushEvents(page)).toEqual(["unsubscribe"]);
    await page.getByRole("button", { name: "Continue enabling" }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(postBody).toMatchObject({ replaceDeviceId: DEVICE });
    expect(await pushEvents(page)).toEqual(["unsubscribe", "subscribe"]);
  });

  test("cleans only a newly-created orphan after POST failure and never retries", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(syntheticStatus()) }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "push-endpoint-unavailable" }) });
    });
    await installControlledSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("The browser push service could not be reached. No device was enabled.")).toBeVisible();
    expect(posts).toBe(1);
    expect(await pushEvents(page)).toEqual(["subscribe", "unsubscribe"]);
  });

  test("keeps successful enrollment in view when storage persistence fails", async ({ page }) => {
    let enrolled = false;
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ devices: enrolled ? [listedDevice] : [] })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      enrolled = true;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: listedDevice }) });
    });
    await installControlledSyntheticPushBrowser(page, { failStorageSet: true });
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Notifications were enabled, but Draw could not remember this browser. Re-enable after reloading.")).toBeVisible();
    await expect(page.getByText("This device", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBeNull();
    expect(await pushEvents(page)).toEqual(["subscribe"]);
  });

  test("does not restore a confirmed-stale handle when cleanup fails before reusing a subscription", async ({ page }) => {
    const staleDevice = "123e4567-e89b-42d3-b456-426614174001";
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    let enrolled = false;
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ devices: enrolled ? [listedDevice] : [] })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      expect(route.request().postDataJSON()).not.toHaveProperty("replaceDeviceId");
      enrolled = true;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: listedDevice }) });
    });
    await installControlledSyntheticPushBrowser(page, {
      subscription: "matching",
      storedHandle: staleDevice,
      failStorageRemove: true,
    });
    await page.goto(`${PROD}/settings`);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(staleDevice);
    expect(await pushEvents(page)).toEqual([]);
    await page.getByRole("button", { name: "Re-enable" }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(await pushEvents(page)).toEqual(["storage-remove"]);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
  });

  test("does not restore a confirmed-stale handle when cleanup fails before creating a subscription", async ({ page }) => {
    const staleDevice = "123e4567-e89b-42d3-b456-426614174001";
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    let enrolled = false;
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ devices: enrolled ? [listedDevice] : [] })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      expect(route.request().postDataJSON()).not.toHaveProperty("replaceDeviceId");
      enrolled = true;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: listedDevice }) });
    });
    await installControlledSyntheticPushBrowser(page, {
      storedHandle: staleDevice,
      failStorageRemove: true,
    });
    await page.goto(`${PROD}/settings`);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(staleDevice);
    expect(await pushEvents(page)).toEqual([]);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(await pushEvents(page)).toEqual(["storage-remove", "subscribe"]);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
  });

  test("does not clear a malformed handle during inspection but clears it on Enable", async ({ page }) => {
    let enrolled = false;
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ devices: enrolled ? [listedDevice] : [] })),
    }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      expect(route.request().postDataJSON()).not.toHaveProperty("replaceDeviceId");
      enrolled = true;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: listedDevice }) });
    });
    await installControlledSyntheticPushBrowser(page, { storedHandle: "malformed-local-handle" });
    await page.goto(`${PROD}/settings`);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe("malformed-local-handle");
    expect(await pushEvents(page)).toEqual([]);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Notifications are enabled for this browser.", { exact: true })).toBeVisible();
    expect(await pushEvents(page)).toEqual(["storage-remove", "subscribe"]);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
  });

  test("does not treat an unavailable status as proof that a handle is stale", async ({ page }) => {
    await installControlledSyntheticPushBrowser(page, { subscription: "matching", storedHandle: DEVICE });
    await page.route("**/api/push/status", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(syntheticStatus({ available: false, reason: "authority-unavailable", vapidPublicKey: null })),
    }));
    await page.goto(`${PROD}/settings`);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
    expect(await pushEvents(page)).toEqual([]);
  });

  test("does not treat a failed status read as proof that a handle is stale", async ({ page }) => {
    await installControlledSyntheticPushBrowser(page, { subscription: "matching", storedHandle: DEVICE });
    await page.route("**/api/push/status", (route) => route.abort());
    await page.goto(`${PROD}/settings`);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
    expect(await pushEvents(page)).toEqual([]);
  });

  test("adopts a validated privacy PUT even when the follow-up status read fails", async ({ page }) => {
    let statusReads = 0;
    await page.route("**/api/push/status", async (route) => {
      statusReads++;
      if (statusReads > 1) return route.abort();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(syntheticStatus()) });
    });
    await page.route("**/api/push/preferences", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ hideDetails: true }),
    }));
    await installControlledSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    const preference = page.getByRole("checkbox", { name: "Hide notification details" });
    await preference.click();
    await expect(preference).toBeChecked();
    await expect(page.getByText("Could not load deadline notification status. Check the connection and try again.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deadline notifications" })).toBeVisible();
  });

  test("adopts validated timing immediately when refresh fails and restores server values after a rejected save", async ({ page }) => {
    let statusReads = 0;
    let reject = false;
    const initial = syntheticStatus({ preferences: { ...timingPreferences(), timezone: "UTC" } });
    await page.route("**/api/push/status", async (route) => {
      statusReads++;
      if (statusReads > 1 && !reject) return route.abort();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(initial) });
    });
    await page.route("**/api/push/preferences", async (route) => {
      if (reject) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid-push-request" }) });
      await route.fulfill({ contentType: "application/json", body: route.request().postData()! });
    });
    await installControlledSyntheticPushBrowser(page);
    await page.goto(`${PROD}/settings`);
    const lead = page.getByLabel("Remind me");
    await lead.selectOption("2");
    await page.getByRole("button", { name: "Save reminder timing" }).click();
    await expect(lead).toHaveValue("2");
    await expect(page.getByText("Could not load deadline notification status. Check the connection and try again.")).toBeVisible();

    reject = true;
    await lead.selectOption("3");
    await page.getByRole("button", { name: "Save reminder timing" }).click();
    await expect(page.getByText("Check the reminder timing and time zone. No settings were changed.")).toBeVisible();
    await expect(lead).toHaveValue("1");
  });

  for (const variant of [
    {
      name: "availability",
      status: syntheticStatus({ available: false, reason: "recovery-pending", vapidPublicKey: null }),
    },
    {
      name: "mutation allowance",
      status: syntheticStatus({ mutationAllowed: false, mutationReason: "secure-transport-required" }),
    },
    {
      name: "VAPID key",
      status: syntheticStatus({ vapidPublicKey: "B" + "A".repeat(85) + "E" }),
    },
  ]) {
    test(`invalidates a rendered continuation when loaded ${variant.name} changes`, async ({ page }) => {
      let currentStatus = syntheticStatus();
      let posts = 0;
      await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(currentStatus) }));
      await page.route("**/api/push/preferences", (route) => {
        currentStatus = { ...variant.status, preferences: timingPreferences(true) };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ hideDetails: true }) });
      });
      await page.route("**/api/push/subscriptions", async (route) => {
        if (route.request().method() === "POST") posts++;
        await route.abort();
      });
      await installControlledSyntheticPushBrowser(page, { permission: "default" });
      await page.goto(`${PROD}/settings`);
      await page.getByRole("button", { name: "Enable", exact: true }).click();
      await expect(page.getByRole("button", { name: "Continue enabling" })).toBeVisible();
      await page.getByRole("checkbox", { name: "Hide notification details" }).click();
      await expect(page.getByRole("button", { name: "Continue enabling" })).toHaveCount(0);
      expect(posts).toBe(0);
      expect(await pushEvents(page)).toEqual(["permission"]);
    });
  }

  test("invalidates a rendered continuation on live permission and worker identity changes before mutation", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(syntheticStatus()) }));
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() === "POST") posts++;
      await route.abort();
    });
    await installControlledSyntheticPushBrowser(page, { permission: "default" });
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue enabling" })).toBeVisible();
    await page.evaluate(() => {
      const control = (globalThis as typeof globalThis & {
        __pushControl: { setPermission: (value: NotificationPermission) => void; replaceWorkerAtSameUrl: () => void };
      }).__pushControl;
      control.setPermission("denied");
      control.replaceWorkerAtSameUrl();
    });
    await page.getByRole("button", { name: "Continue enabling" }).click();
    expect(posts).toBe(0);
    expect(await pushEvents(page)).toEqual(["permission"]);
  });

  test("orders local disable, other-device revoke, revoke-all, and recovery cleanup", async ({ page }) => {
    const OTHER = "223e4567-e89b-42d3-a456-426614174000";
    const row = (id: string) => ({ id, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" });
    let devicesState = [row(DEVICE), row(OTHER)];
    let failRevokeAll = false;
    await page.route("**/api/push/status", async (route) => {
      await recordPushEvent(page, "status");
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(syntheticStatus({ devices: devicesState })) });
    });
    await page.route("**/api/push/subscriptions/**", async (route) => {
      const id = route.request().url().split("/").pop()!;
      await recordPushEvent(page, `delete:${id}`);
      devicesState = devicesState.filter((device) => device.id !== id);
      await route.fulfill({ status: 204 });
    });
    await page.route("**/api/push/subscriptions", async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await recordPushEvent(page, failRevokeAll ? "delete-all-failed" : "delete-all");
      devicesState = [];
      await route.fulfill(failRevokeAll
        ? { status: 503, contentType: "application/json", body: JSON.stringify({ error: "push-busy" }) }
        : { status: 204 });
    });
    await installControlledSyntheticPushBrowser(page, { subscription: "matching", storedHandle: DEVICE });
    await page.goto(`${PROD}/settings`);
    await page.evaluate(() => { (globalThis as typeof globalThis & { __pushControl: { events: string[] } }).__pushControl.events.length = 0; });
    const localRow = page.locator(".push-device").filter({ hasText: "This device" });
    await localRow.getByRole("button", { name: "Disable this device" }).click();
    await expect(localRow).toHaveCount(0);
    expect((await pushEvents(page)).slice(-4)).toEqual([`delete:${DEVICE}`, "unsubscribe", "storage-remove", "status"]);

    // Reload with only an other row: revoking it must never mutate the browser.
    devicesState = [row(OTHER)];
    await page.reload();
    await page.evaluate(() => { (globalThis as typeof globalThis & { __pushControl: { events: string[] } }).__pushControl.events.length = 0; });
    await page.locator(".push-device").filter({ hasText: "Other device" }).getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator(".push-device")).toHaveCount(0);
    expect((await pushEvents(page)).slice(-3)).toEqual(["storage-remove", `delete:${OTHER}`, "status"]);

    devicesState = [row(DEVICE)];
    await page.reload();
    await page.evaluate(() => { (globalThis as typeof globalThis & { __pushControl: { events: string[] } }).__pushControl.events.length = 0; });
    await page.getByRole("button", { name: "Revoke all devices" }).click();
    await expect(page.locator(".push-device")).toHaveCount(0);
    expect((await pushEvents(page)).slice(-4)).toEqual(["delete-all", "unsubscribe", "storage-remove", "status"]);

    // Failed revoke-all whose read-back proves removal performs local cleanup,
    // then reports the original closed failure after the second read-back.
    devicesState = [row(DEVICE)];
    failRevokeAll = true;
    await page.evaluate((id) => localStorage.setItem("draw.push.device.v1", id), DEVICE);
    await page.reload();
    await page.evaluate(() => { (globalThis as typeof globalThis & { __pushControl: { events: string[] } }).__pushControl.events.length = 0; });
    await page.getByRole("button", { name: "Revoke all devices" }).click();
    await expect(page.getByText("Notification service is busy. Try again.")).toBeVisible();
    expect((await pushEvents(page)).slice(-5)).toEqual(["delete-all-failed", "status", "unsubscribe", "storage-remove", "status"]);
  });

  test("reports cleanup failure after confirmed server removal without reconstructing server state", async ({ page }) => {
    let devicesState = [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }];
    await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(syntheticStatus({ devices: devicesState })) }));
    await page.route("**/api/push/subscriptions/**", async (route) => {
      devicesState = [];
      await route.fulfill({ status: 204 });
    });
    await installControlledSyntheticPushBrowser(page, {
      subscription: "matching",
      storedHandle: DEVICE,
      unsubscribeResult: false,
      failStorageRemove: true,
    });
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Disable this device" }).click();
    await expect(page.getByText("The server device was removed, but browser cleanup could not be confirmed. Reload Draw and check browser site settings.")).toBeVisible();
    expect(devicesState).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBe(DEVICE);
  });

  test("refetches and closes test/mutation error states before presenting guidance", async ({ page }) => {
    const listedDevice = { id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    let currentStatus = syntheticStatus({ devices: [listedDevice] });
    let testCode = "push-test-cancelled";
    await page.route(`**/api/push/subscriptions/${DEVICE}/test`, (route) => route.fulfill({
      status: testCode === "push-device-not-found" ? 404 : 409,
      contentType: "application/json",
      body: JSON.stringify({ error: testCode }),
    }));
    await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(currentStatus) }));
    await installControlledSyntheticPushBrowser(page, { subscription: "matching", storedHandle: DEVICE });
    await page.goto(`${PROD}/settings`);
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("Test send cancelled because notification state changed")).toBeVisible();

    testCode = "push-device-not-found";
    currentStatus = syntheticStatus();
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("This device is no longer enrolled. Choose Enable to enroll it again.")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("draw.push.device.v1"))).toBeNull();
    await expect(page.getByText("This device", { exact: true })).toHaveCount(0);
  });
});

test.describe("Deadline notification Settings — Pixel 7 production build", () => {
  test.use({ ...PIXEL_7 });
  test("keeps controls responsive with synthetic browser/API seams", async ({ page }) => {
    await exerciseSyntheticSettings(page);
    const buttons = await page.locator(".push-notifications button").all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});
