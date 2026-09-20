import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ToastSnapshot {
  text: string;
  key: string | null;
  node: number;
}

async function reserveLoopbackPort(): Promise<number> {
  const reservation = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (address == null || typeof address === "string") {
      throw new Error("Failed to reserve a loopback port");
    }
    return address.port;
  } finally {
    if (reservation.listening) {
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

async function snapshot(page: Page): Promise<ToastSnapshot | null> {
  return page.evaluate(() => (window as any).toastSnapshot());
}

async function unlock(page: Page, keys: string[]) {
  await page.evaluate((detail) => (window as any).unlock(detail), keys);
}

async function expectQueueToDrain(page: Page) {
  await expect(page.locator(".ach-toast")).toHaveCount(0, { timeout: 6_500 });
}

test("achievement toast identities survive StrictMode Fast Refresh and reset only with their owner", async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const repositoryRoot = process.cwd();
  const productSource = path.join(
    repositoryRoot,
    "client",
    "src",
    "components",
    "AchievementToast.tsx",
  );
  const browserErrors: string[] = [];
  const externalRequests: string[] = [];
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let viteServer: { close(): Promise<void> } | undefined;
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draw-toast-refresh-"));

  try {
    const sourceRoot = path.join(harnessRoot, "src");
    const harnessComponent = path.join(sourceRoot, "AchievementToast.tsx");
    const requireFromRepository = createRequire(path.join(repositoryRoot, "package.json"));
    const dependencyRoot = path.dirname(requireFromRepository.resolve("react/package.json"));
    fs.mkdirSync(sourceRoot, { recursive: true });
    const componentSource = fs.readFileSync(productSource, "utf8");
    fs.writeFileSync(harnessComponent, componentSource);
    fs.writeFileSync(path.join(harnessRoot, "package.json"), '{"private":true,"type":"module"}');
    fs.writeFileSync(
      path.join(harnessRoot, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    );
    fs.writeFileSync(
      path.join(sourceRoot, "stubs.tsx"),
      [
        "export function useGamification(){return {data:undefined};}",
        "export function achievementRarity(){return 'common';}",
        "export function celebrate(){}",
        "export function prefersReducedMotion(){return true;}",
        "export function AchievementCard(){return null;}",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(sourceRoot, "empty.css"), "");
    fs.writeFileSync(
      path.join(sourceRoot, "main.tsx"),
      `import React, {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AchievementToast} from './AchievementToast';
const root=createRoot(document.getElementById('root'));
const nodes=new WeakMap(); let nextNode=1;
window.mount=()=>flushSync(()=>root.render(<StrictMode><AchievementToast/></StrictMode>));
window.unmount=()=>flushSync(()=>root.render(null));
window.unlock=(keys)=>flushSync(()=>window.dispatchEvent(new CustomEvent('achievements-unlocked',{detail:keys})));
window.toastSnapshot=()=>{const el=document.querySelector('.ach-toast');if(!el)return null;if(!nodes.has(el))nodes.set(el,nextNode++);const prop=Object.keys(el).find((key)=>key.startsWith('__reactFiber$'));let fiber=prop&&el[prop];while(fiber&&fiber.key==null)fiber=fiber.return;return {text:el.textContent,key:fiber?.key??null,node:nodes.get(el)};};
window.mount();`,
    );

    const { createServer } = await import(
      pathToFileURL(requireFromRepository.resolve("vite")).href
    );
    const { default: react } = await import(
      pathToFileURL(requireFromRepository.resolve("@vitejs/plugin-react")).href
    );
    const port = await reserveLoopbackPort();
    viteServer = await createServer({
      configFile: false,
      root: harnessRoot,
      cacheDir: path.join(harnessRoot, "node_modules", ".vite"),
      plugins: [react()],
      resolve: {
        alias: {
          react: path.dirname(requireFromRepository.resolve("react/package.json")),
          "react-dom": path.dirname(requireFromRepository.resolve("react-dom/package.json")),
          "../hooks/useGamification": path.join(sourceRoot, "stubs.tsx"),
          "../lib/achievementRarity": path.join(sourceRoot, "stubs.tsx"),
          "../lib/celebrate": path.join(sourceRoot, "stubs.tsx"),
          "./AchievementCard": path.join(sourceRoot, "stubs.tsx"),
          "./AchievementToast.css": path.join(sourceRoot, "empty.css"),
        },
      },
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        fs: { allow: [harnessRoot, dependencyRoot] },
      },
      logLevel: "warn",
    });
    await viteServer.listen();
    const origin = `http://127.0.0.1:${port}`;

    context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(String(error)));
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === origin) await route.continue();
      else {
        externalRequests.push(route.request().url());
        await route.abort();
      }
    });

    async function freshHarness() {
      await page.goto(origin);
      await page.waitForFunction(() => typeof (window as any).unlock === "function");
    }

    await freshHarness();
    await unlock(page, ["ordinary-alpha", "ordinary-beta"]);
    await expect(page.getByText("ordinary-alpha", { exact: true })).toBeVisible();
    const ordinaryFirst = await snapshot(page);
    await expect(page.getByText("ordinary-beta", { exact: true })).toBeVisible({ timeout: 6_500 });
    const ordinarySecond = await snapshot(page);
    expect(ordinarySecond?.key).not.toBe(ordinaryFirst?.key);
    expect(ordinarySecond?.node).not.toBe(ordinaryFirst?.node);
    await expectQueueToDrain(page);

    await unlock(page, ["repeated", "repeated"]);
    await expect(page.getByText("repeated", { exact: true })).toBeVisible();
    const repeatedFirst = await snapshot(page);
    expect(repeatedFirst).not.toBeNull();
    expect(repeatedFirst?.key).not.toBeNull();
    await page.waitForFunction(
      (first) => {
        const second = (window as any).toastSnapshot();
        return (
          second !== null &&
          second.key !== null &&
          second.key !== first.key &&
          second.node !== first.node
        );
      },
      repeatedFirst,
      { timeout: 6_500 },
    );
    const repeatedSecond = await snapshot(page);
    expect(repeatedSecond).not.toBeNull();
    expect(repeatedSecond?.key).not.toBeNull();
    expect(repeatedSecond?.key).not.toBe(repeatedFirst?.key);
    expect(repeatedSecond?.node).not.toBe(repeatedFirst?.node);
    await expectQueueToDrain(page);

    await freshHarness();
    await unlock(page, ["before-remount"]);
    await expect(page.getByText("before-remount", { exact: true })).toBeVisible();
    const beforeRemount = await snapshot(page);
    await page.evaluate(() => {
      (window as any).unmount();
      (window as any).mount();
    });
    await expect(page.locator(".ach-toast")).toHaveCount(0);
    await unlock(page, ["after-remount"]);
    await expect(page.getByText("after-remount", { exact: true })).toBeVisible();
    const afterRemount = await snapshot(page);
    // A new owner may restart its IDs; only the discarded queue and fresh DOM mount matter.
    expect(afterRemount?.node).not.toBe(beforeRemount?.node);
    await expectQueueToDrain(page);

    await freshHarness();
    await unlock(page, ["refresh-alpha"]);
    await expect(page.getByText("refresh-alpha", { exact: true })).toBeVisible();
    const beforeRefresh = await snapshot(page);
    const hotUpdate = page.waitForEvent("console", {
      predicate: (message) => message.text().includes("hot updated: /src/AchievementToast.tsx"),
      timeout: 12_000,
    });
    fs.writeFileSync(
      harnessComponent,
      `${componentSource}\n// Comment-only Fast Refresh probe; product behavior is unchanged.\n`,
    );
    await hotUpdate;
    // The client log precedes React's queued refresh work; let that work settle before dispatching.
    await page.waitForTimeout(200);
    await expect(page.getByText("refresh-alpha", { exact: true })).toBeVisible();
    const afterRefresh = await snapshot(page);
    expect(afterRefresh).toEqual(beforeRefresh);

    await unlock(page, ["refresh-beta"]);
    await expect(page.getByText("refresh-beta", { exact: true })).toBeVisible({ timeout: 6_500 });
    const afterHandoff = await snapshot(page);
    expect(afterHandoff?.key).not.toBe(beforeRefresh?.key);
    expect(afterHandoff?.node).not.toBe(beforeRefresh?.node);
    await expectQueueToDrain(page);
    // One event entry consumes one owner-local ID, even when StrictMode replays state work.
    expect(Number(afterHandoff?.key)).toBe(Number(beforeRefresh?.key) + 1);

    expect(browserErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await viteServer?.close();
      } finally {
        fs.rmSync(harnessRoot, { recursive: true, force: true });
      }
    }
  }
});
