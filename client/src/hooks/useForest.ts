import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FOREST_QUERY_KEY,
  StaleForestGenerationError,
  forestLoader,
  type ForestState,
  type PublishedForest,
} from "../lib/forest";

export function useForest() {
  const queryClient = useQueryClient();
  const loader = forestLoader(queryClient);
  const query = useQuery<PublishedForest, Error, ForestState>({
    queryKey: FOREST_QUERY_KEY,
    queryFn: ({ signal }) => loader.load(null, signal),
    retry: false,
  });
  const [navigationPending, setNavigationPending] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const retryCursor = useRef<number | null>(null);
  const navigationAttempt = useRef(0);

  const navigate = useCallback(async (beforeId: number | null) => {
    const attempt = ++navigationAttempt.current;
    retryCursor.current = beforeId;
    setNavigationPending(true);
    setNavigationError(null);
    await queryClient.cancelQueries({ queryKey: FOREST_QUERY_KEY, exact: true }, { revert: false });
    try {
      const result = await loader.load(beforeId);
      if (attempt !== navigationAttempt.current) return;
      queryClient.setQueryData<ForestState>(FOREST_QUERY_KEY, result);
    } catch (error) {
      if (attempt !== navigationAttempt.current || error instanceof StaleForestGenerationError) return;
      setNavigationError("The forest could not be refreshed.");
    } finally {
      if (attempt === navigationAttempt.current) setNavigationPending(false);
    }
  }, [loader, queryClient]);

  const retry = useCallback(() => navigate(retryCursor.current), [navigate]);

  return { query, navigate, retry, navigationPending, navigationError };
}
