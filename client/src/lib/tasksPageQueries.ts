import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Exact unpaged datasets owned by the Tasks page's List/Due dates subtree.
 * Week never observes these keys. The explicit keys avoid disturbing scoped
 * task/goal queries that another mounted feature may own.
 */
export const TASKS_PAGE_DATASET_KEYS: readonly QueryKey[] = [
  ["tasks", "status=open"],
  ["tasks", "status=all"],
  ["goals", "active"],
];

/**
 * Cancel and release only inactive List/Due dates datasets. Call this after
 * that subtree unmounts: an independently mounted observer keeps its query
 * and in-flight request untouched.
 */
export async function releaseTasksPageDatasets(queryClient: QueryClient): Promise<void> {
  const inactiveKeys = TASKS_PAGE_DATASET_KEYS.filter((queryKey) => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    return query !== undefined && query.getObserversCount() === 0;
  });

  await Promise.all(inactiveKeys.map((queryKey) =>
    queryClient.cancelQueries({ queryKey, exact: true }),
  ));

  for (const queryKey of inactiveKeys) {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (query && query.getObserversCount() === 0) {
      queryClient.removeQueries({ queryKey, exact: true });
    }
  }
}
