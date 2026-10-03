import { useCallback, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  FOREST_QUERY_KEY,
  StaleForestGenerationError,
  forestLoader,
  type ForestGenerationLoader,
  type ForestState,
  type PublishedForest,
} from "../lib/forest";

export function forestQueryOptions(
  queryClient: QueryClient,
): UseQueryOptions<PublishedForest, Error, ForestState, typeof FOREST_QUERY_KEY> {
  const loader = forestLoader(queryClient);
  return {
    queryKey: FOREST_QUERY_KEY,
    queryFn: ({ signal }) => loader.load(null, signal),
    retry: false,
  };
}

export interface ForestNavigationState {
  navigationPending: boolean;
  navigationError: string | null;
  retryCursor: number | null;
}

/**
 * Deterministic navigation owner used by useForest. Keeping attempts and the
 * retry cursor together makes an Older retry target the same cursor while a
 * failed Newest preserves the last validated cache publication.
 */
export class ForestNavigationController {
  private attempt = 0;
  private state: ForestNavigationState = {
    navigationPending: false,
    navigationError: null,
    retryCursor: null,
  };

  constructor(
    private readonly queryClient: QueryClient,
    private readonly loader: ForestGenerationLoader = forestLoader(queryClient),
    private readonly onStateChange: () => void = () => undefined,
  ) {}

  snapshot(): Readonly<ForestNavigationState> {
    return this.state;
  }

  navigate = async (beforeId: number | null): Promise<void> => {
    const attempt = ++this.attempt;
    this.state = { navigationPending: true, navigationError: null, retryCursor: beforeId };
    this.onStateChange();
    await this.queryClient.cancelQueries({ queryKey: FOREST_QUERY_KEY, exact: true }, { revert: false });
    try {
      const result = await this.loader.load(beforeId);
      if (attempt !== this.attempt) return;
      this.queryClient.setQueryData<ForestState>(FOREST_QUERY_KEY, result);
    } catch (error) {
      if (attempt !== this.attempt || error instanceof StaleForestGenerationError) return;
      this.state = { ...this.state, navigationError: "The forest could not be refreshed." };
      this.onStateChange();
    } finally {
      if (attempt === this.attempt) {
        this.state = { ...this.state, navigationPending: false };
        this.onStateChange();
      }
    }
  };

  retry = (): Promise<void> => this.navigate(this.state.retryCursor);
}

export function useForest() {
  const queryClient = useQueryClient();
  const query = useQuery<PublishedForest, Error, ForestState, typeof FOREST_QUERY_KEY>(
    forestQueryOptions(queryClient),
  );
  const [, setNavigationRevision] = useState(0);
  const controllerRef = useRef<ForestNavigationController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new ForestNavigationController(
      queryClient,
      forestLoader(queryClient),
      () => setNavigationRevision((revision) => revision + 1),
    );
  }
  const controller = controllerRef.current;
  const navigation = controller.snapshot();
  const navigate = useCallback(controller.navigate, [controller]);
  const retry = useCallback(controller.retry, [controller]);

  return {
    query,
    navigate,
    retry,
    navigationPending: navigation.navigationPending,
    navigationError: navigation.navigationError,
  };
}
