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
): UseQueryOptions<ForestState, Error, ForestState, typeof FOREST_QUERY_KEY> {
  const loader = forestLoader(queryClient);
  return {
    queryKey: FOREST_QUERY_KEY,
    queryFn: ({ signal }) => loader.load(null, signal),
    // TanStack Query calls structuralSharing from Query.setData, immediately
    // before the cache replacement. That is the final shared-epoch guard for
    // a reset racing an already-resolved query function.
    structuralSharing: (previous, candidate) => {
      const priorState = previous as ForestState | undefined;
      const nextState = candidate as ForestState;
      return nextState.kind === "published"
        ? loader.publishIfCurrent(priorState, nextState)
        : nextState;
    },
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
    private readonly beforePublication?: (result: PublishedForest) => void | Promise<void>,
  ) {}

  snapshot(): Readonly<ForestNavigationState> {
    return this.state;
  }

  navigate = async (beforeId: number | null): Promise<void> => {
    const attempt = ++this.attempt;
    const startingEpoch = this.loader.epoch();
    this.state = { navigationPending: true, navigationError: null, retryCursor: beforeId };
    this.onStateChange();
    await this.queryClient.cancelQueries({ queryKey: FOREST_QUERY_KEY, exact: true }, { revert: false });
    try {
      // A reset while cancelQueries was settling owns page one; this older
      // navigation must not start afterward and supersede that recovery.
      if (attempt !== this.attempt || !this.loader.isEpochCurrent(startingEpoch)) return;
      const result = await this.loader.load(beforeId);
      if (attempt !== this.attempt) return;
      if (this.beforePublication) await this.beforePublication(result);
      if (attempt !== this.attempt) return;
      this.queryClient.setQueryData<ForestState>(FOREST_QUERY_KEY, (previous) =>
        this.loader.publishIfCurrent(previous, result),
      );
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
  const query = useQuery<ForestState, Error, ForestState, typeof FOREST_QUERY_KEY>(
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
