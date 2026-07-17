import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, environmentManager, isServer } from "@tanstack/react-query";
import { heldCardResolved } from "../lib/drawnCard";

// The held-card watch gate (#130): the DrawPage stops the #118 watch the
// moment its release verdict is in — `enabled` is the verdict itself, in
// React Query's callback form — instead of polling an idle deck every 60s
// for a card that already left. The gate leans on two library behaviors,
// exercised here through query-core's own QueryObserver (the exact machinery
// useQuery drives, no DOM needed; the useAi.test.ts pattern):
//   1. the enabled callback is re-resolved against the query's OWN state on
//      every change, so the refetch that proves the card resolved is also
//      the one that stops the interval;
//   2. a query disabled that way keeps its data and dataUpdatedAt — the
//      verdict, once released, can never flip back.
describe("the held-card watch gate (#130)", () => {
  afterEach(() => {
    vi.useRealTimers();
    environmentManager.setIsServer(() => isServer);
  });

  it("the refetch that releases the hold also stops the 60s poll — the watch dies with its hold", async () => {
    vi.useFakeTimers();
    // query-core never arms refetch intervals where `window` is undefined —
    // tell it this Node test IS the browser it guards against.
    environmentManager.setIsServer(() => false);
    const qc = new QueryClient();
    let fetches = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ["tasks", "status=all"],
      // First answer: the held card still open — the hold stands. Every
      // later answer: completed elsewhere — the release.
      queryFn: async () => {
        fetches += 1;
        return [{ id: 7, status: fetches === 1 ? "open" : "done" }];
      },
      refetchInterval: 60_000,
      // The DrawPage gate, minus the session clauses that don't move in this
      // scenario: the verdict over the query's own data IS `enabled`.
      enabled: (query) => !heldCardResolved(query.state.data, 7),
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); // settle the mount fetch
    expect(fetches).toBe(1);

    // The poll is genuinely armed while the hold stands…
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches).toBe(2);

    // …and the very answer that released the hold disarmed it: query-core
    // re-resolves the callback on the query's state change and clears the
    // interval on false — no re-render needed, no effect, no residue.
    await vi.advanceTimersByTimeAsync(600_000); // ten would-be polls later…
    expect(fetches).toBe(2); // …the idle deck makes no request

    unsubscribe();
  });

  it("disabling the watch keeps data and dataUpdatedAt — the released verdict cannot flip back", async () => {
    const qc = new QueryClient();
    const key = ["tasks", "status=all"];
    const doneTask = { id: 7, status: "done" };
    const options = {
      queryKey: key,
      queryFn: async () => [doneTask],
    };
    const observer = new QueryObserver(qc, { ...options, enabled: true });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("success"));
    const settledAt = observer.getCurrentResult().dataUpdatedAt;
    expect(settledAt).toBeGreaterThan(0);

    // The verdict flips released — the still-mounted observer is disabled,
    // whether by the callback resolving false or a re-render's setOptions.
    observer.setOptions({ ...options, enabled: false });

    // The disabled query keeps its timestamp and its data: `released` reads
    // both (`dataUpdatedAt >= heldSince` and the resolved card), so the
    // verdict holds for the rest of the hold — the card cannot blink back.
    expect(observer.getCurrentResult().dataUpdatedAt).toBe(settledAt);
    expect(observer.getCurrentResult().data).toEqual([doneTask]);
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(settledAt);
    unsubscribe();
  });
});
