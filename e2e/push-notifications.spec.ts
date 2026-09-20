import { devices, expect, test, type Page } from "@playwright/test";
import vm from "node:vm";

const PROD = `http://127.0.0.1:${process.env.E2E_PROD_PORT || "3102"}`;
const DEVICE = "123e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const { defaultBrowserType: _defaultBrowserType, ...PIXEL_7 } = devices["Pixel 7"];

interface WorkerHarness {
  listeners: Map<string, (event: any) => void>;
  notifications: Array<{ title: string; options: Record<string, unknown> }>;
  cacheCalls: string[];
  clients: any[];
  opened: string[];
}

function executeWorker(source: string): WorkerHarness {
  const listeners = new Map<string, (event: any) => void>();
  const notifications: WorkerHarness["notifications"] = [];
  const cacheCalls: string[] = [];
  const clients: any[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://draw.test" },
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

async function exerciseSyntheticSettings(page: Page) {
  let hideDetails = false;
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
      preferences: { hideDetails },
      devices: [{ id: DEVICE, createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z" }],
    }),
  }));
  await page.route("**/api/push/preferences", async (route) => {
    putBody = route.request().postDataJSON();
    hideDetails = (putBody as { hideDetails: boolean }).hideDetails;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ hideDetails }) });
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
        preferences: { hideDetails: false },
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
        preferences: { hideDetails: false },
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

  test("unmount during a pending synthetic subscription cleans the new orphan and never POSTs", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/push/status", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        available: true, reason: null, mutationAllowed: true, mutationReason: null,
        vapidPublicKey: "B" + "A".repeat(86), maxDevices: 16,
        preferences: { hideDetails: false }, devices: [],
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
