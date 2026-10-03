import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { FOREST_QUERY_KEY, forestLoader, type ForestState } from "../lib/forest";
import { importBackupMutation } from "./useBackup";
import { ForestNavigationController, forestQueryOptions } from "./useForest";
import { deleteTaskMutation } from "./useTasks";

const START = "2026-01-02T03:04:05.006Z";
const END = "2026-01-02T03:05:05.006Z";

type PendingResponse = Promise<Response> | Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function page(id: number, nextBeforeId: number | null = null) {
  return {
    trees: [{ id, startedAt: START, endedAt: END, endReason: "done" }],
    nextBeforeId,
  };
}

function published(id: number, requestedBeforeId: number | null): ForestState {
  return {
    kind: "published",
    requestedBeforeId,
    current: null,
    page: { trees: [{ id, startedAt: START, endedAt: END, endReason: "done" }], nextBeforeId: null },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installHttp(routes: Record<string, PendingResponse[]>): void {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : new URL(input.url).pathname;
    const response = routes[url]?.shift();
    if (!response) throw new Error(`Unexpected HTTP request: ${url}`);
    return Promise.resolve(response);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("useForest query and navigation controller", () => {
  it("publishes a full initial page/current pair through the hook query options", async () => {
    installHttp({
      "/api/forest": [json(page(9))],
      "/api/timer/current": [json(null)],
    });
    const qc = new QueryClient();

    await expect(qc.fetchQuery(forestQueryOptions(qc))).resolves.toMatchObject({
      kind: "published",
      requestedBeforeId: null,
      page: { trees: [{ id: 9 }] },
      current: null,
    });
  });

  it.each([
    ["forest", json({ trees: [{ id: 9 }], nextBeforeId: null }), json(null)],
    ["current timer", json(page(9)), json({ entry: null, task: null })],
  ])("rejects an initial generation when the %s source is malformed", async (_source, forest, current) => {
    installHttp({
      "/api/forest": [forest],
      "/api/timer/current": [current],
    });
    const qc = new QueryClient();

    await expect(qc.fetchQuery(forestQueryOptions(qc))).rejects.toThrow("Invalid");
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toBeUndefined();
  });

  it.each([
    ["forest", json({ error: "forest unavailable" }, 503), json(null)],
    ["current timer", json(page(9)), json({ error: "timer unavailable" }, 503)],
  ])("publishes neither half when the %s source fails", async (_source, forest, current) => {
    installHttp({
      "/api/forest": [forest],
      "/api/timer/current": [current],
    });
    const qc = new QueryClient();

    await expect(qc.fetchQuery(forestQueryOptions(qc))).rejects.toBeInstanceOf(Error);
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toBeUndefined();
  });

  it("retries both sources after initial failure and publishes page one", async () => {
    installHttp({
      "/api/forest": [json({ error: "unavailable" }, 500), json(page(8))],
      "/api/timer/current": [json(null), json(null)],
    });
    const qc = new QueryClient();
    await expect(qc.fetchQuery(forestQueryOptions(qc))).rejects.toThrow();
    const controller = new ForestNavigationController(qc);

    await controller.retry();

    expect(controller.snapshot()).toEqual({ navigationPending: false, navigationError: null, retryCursor: null });
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toMatchObject({
      kind: "published",
      requestedBeforeId: null,
      page: { trees: [{ id: 8 }] },
    });
  });

  it("preserves an Older page on failure and Retry uses the same cursor", async () => {
    installHttp({
      "/api/forest?beforeId=101": [json({ trees: [{ id: 101, startedAt: START, endedAt: END, endReason: "done" }], nextBeforeId: null }), json(page(80))],
      "/api/timer/current": [json(null), json(null)],
    });
    const qc = new QueryClient();
    const previous = published(150, null);
    qc.setQueryData(FOREST_QUERY_KEY, previous);
    const controller = new ForestNavigationController(qc);

    await controller.navigate(101);
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
    expect(controller.snapshot()).toEqual({
      navigationPending: false,
      navigationError: "The forest could not be refreshed.",
      retryCursor: 101,
    });

    await controller.retry();
    expect(qc.getQueryData(FOREST_QUERY_KEY)).toMatchObject({
      requestedBeforeId: 101,
      page: { trees: [{ id: 80 }] },
    });
  });

  it("preserves the validated older window when Newest fails", async () => {
    installHttp({
      "/api/forest": [json({ error: "newest unavailable" }, 503)],
      "/api/timer/current": [json(null)],
    });
    const qc = new QueryClient();
    const previous = published(80, 101);
    qc.setQueryData(FOREST_QUERY_KEY, previous);
    const controller = new ForestNavigationController(qc);

    await controller.navigate(null);

    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual(previous);
    expect(controller.snapshot().retryCursor).toBeNull();
    expect(controller.snapshot().navigationError).not.toBeNull();
  });

  it.each([
    [
      "delete",
      "/api/tasks/7",
      json({ ok: true }),
      (qc: QueryClient) => new MutationObserver(qc, deleteTaskMutation(qc)).mutate(7),
    ],
    [
      "backup replacement",
      "/api/backup/import",
      json({ tasks: 1, goals: 2, materials: 3 }),
      (qc: QueryClient) => new MutationObserver(qc, importBackupMutation(qc)).mutate(
        new File(["archive"], "draw.zip"),
      ),
    ],
  ])("does not resurrect old trees/current/cursor when %s resets after navigation validation but before publication", async (
    _name,
    producerUrl,
    producerResponse,
    settleProducer,
  ) => {
    installHttp({
      "/api/forest?beforeId=101": [json(page(80))],
      "/api/timer/current": [json({
        entry: { id: 70, taskId: 7, startedAt: START, endedAt: null },
        task: { id: 7, title: "must not resurrect", categoryId: 2, impact: 3, effortMinutes: 20, goalId: null, status: "open" },
      })],
      [producerUrl]: [producerResponse],
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    qc.setQueryData(FOREST_QUERY_KEY, published(150, null));
    const controller = new ForestNavigationController(
      qc,
      forestLoader(qc),
      () => undefined,
      async () => { await settleProducer(qc); },
    );

    await controller.navigate(101);

    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual({ kind: "cleared" });
    expect(qc.getQueryData(FOREST_QUERY_KEY)).not.toMatchObject({
      requestedBeforeId: 101,
      page: { trees: [{ id: 80 }] },
      current: { entry: { id: 70 } },
    });
  });

  it("guards TanStack Query's final cache publication with the reset epoch", async () => {
    installHttp({
      "/api/forest?beforeId=101": [json(page(80))],
      "/api/timer/current": [json(null)],
      "/api/tasks/7": [json({ ok: true })],
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    qc.setQueryData(FOREST_QUERY_KEY, published(150, null));
    const stalePublication = await forestLoader(qc).load(101);

    await new MutationObserver(qc, deleteTaskMutation(qc)).mutate(7);
    await qc.fetchQuery({
      ...forestQueryOptions(qc),
      queryFn: async () => stalePublication,
    });

    expect(qc.getQueryData(FOREST_QUERY_KEY)).toEqual({ kind: "cleared" });
  });

  it("rejects late Older/current results after Newest publishes", async () => {
    const oldForest = deferred<Response>();
    const oldCurrent = deferred<Response>();
    const newForest = deferred<Response>();
    const newCurrent = deferred<Response>();
    installHttp({
      "/api/forest?beforeId=101": [oldForest.promise],
      "/api/forest": [newForest.promise],
      "/api/timer/current": [oldCurrent.promise, newCurrent.promise],
    });
    const qc = new QueryClient();
    qc.setQueryData(FOREST_QUERY_KEY, published(150, null));
    const controller = new ForestNavigationController(qc);

    const older = controller.navigate(101);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const newest = controller.navigate(null);
    newForest.resolve(json(page(99)));
    newCurrent.resolve(json(null));
    await newest;
    oldForest.resolve(json(page(80)));
    oldCurrent.resolve(json(null));
    await older;

    expect(qc.getQueryData(FOREST_QUERY_KEY)).toMatchObject({
      requestedBeforeId: null,
      page: { trees: [{ id: 99 }] },
    });
    expect(controller.snapshot()).toEqual({ navigationPending: false, navigationError: null, retryCursor: null });
  });
});
