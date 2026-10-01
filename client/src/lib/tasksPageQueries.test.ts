import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { releaseTasksPageDatasets } from "./tasksPageQueries";

describe("Tasks-page dataset release", () => {
  it("cancels in-flight List data and removes exact retained task/goal datasets", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let aborted = false;
    const pending = queryClient.fetchQuery({
      queryKey: ["tasks", "status=open"],
      queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    }).catch(() => undefined);
    queryClient.setQueryData(["tasks", "status=all"], [{ id: 1 }]);
    queryClient.setQueryData(["goals", "active"], [{ id: 2 }]);
    queryClient.setQueryData(["tasks", "status=open", "other-owner"], [{ id: 3 }]);

    await releaseTasksPageDatasets(queryClient);
    await pending;

    expect(aborted).toBe(true);
    expect(queryClient.getQueryData(["tasks", "status=open"])).toBeUndefined();
    expect(queryClient.getQueryData(["tasks", "status=all"])).toBeUndefined();
    expect(queryClient.getQueryData(["goals", "active"])).toBeUndefined();
    expect(queryClient.getQueryData(["tasks", "status=open", "other-owner"])).toEqual([{ id: 3 }]);
  });

  it("does not cancel or clear an exact dataset with another active observer", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi.fn(async () => [{ id: 7 }]);
    const observer = new QueryObserver(queryClient, {
      queryKey: ["goals", "active"],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();

    await releaseTasksPageDatasets(queryClient);

    expect(queryClient.getQueryData(["goals", "active"])).toEqual([{ id: 7 }]);
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
    queryClient.clear();
  });
});
