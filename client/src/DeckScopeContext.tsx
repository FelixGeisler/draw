import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useCategories } from "./hooks/useTasks";
import { DECK_SCOPE_KEY, resolveDeckScope, serializeDeckScope, type DeckScope } from "./lib/deckScope";

/**
 * Work mode (#214): the app-wide, per-device deck scope.
 *
 * Deliberately NOT in hooks/ — that directory is TanStack Query server state,
 * and this is a device preference that never reaches the server. It is also
 * deliberately not in the `settings` table; see lib/deckScope.ts for why.
 */
interface DeckScopeValue {
  /** `undefined` = the whole deck. */
  scope: DeckScope;
  setScope: (scope: DeckScope) => void;
}

const Ctx = createContext<DeckScopeValue>({ scope: undefined, setScope: () => {} });

/** localStorage can throw (private mode, disabled storage) — a lost preference must never break the app. */
function readStored(): string | null {
  try {
    return localStorage.getItem(DECK_SCOPE_KEY);
  } catch {
    return null;
  }
}

export function DeckScopeProvider({ children }: { children: React.ReactNode }) {
  const categories = useCategories();
  const [raw, setRaw] = useState<string | null>(readStored);

  const knownIds = useMemo(() => (categories.data ?? []).map((c) => c.id), [categories.data]);
  const scope = resolveDeckScope(raw, knownIds);

  // Prune a scope whose category is gone. Derived state decides (resolveDeckScope
  // above already returns undefined, so the UI is correct on this very render);
  // this only cleans the stored value so it cannot resurrect if an id is reused.
  useEffect(() => {
    if (raw != null && scope == null && knownIds.length > 0) {
      try {
        localStorage.removeItem(DECK_SCOPE_KEY);
      } catch {
        // ignore — the derived value already reads as the whole deck
      }
      setRaw(null);
    }
  }, [raw, scope, knownIds.length]);

  const setScope = useCallback((next: DeckScope) => {
    const serialized = serializeDeckScope(next);
    try {
      if (serialized == null) localStorage.removeItem(DECK_SCOPE_KEY);
      else localStorage.setItem(DECK_SCOPE_KEY, serialized);
    } catch {
      // Storage unavailable: the scope still applies for this session, it just
      // will not survive a reload. Better than refusing to switch mode.
    }
    setRaw(serialized);
  }, []);

  const value = useMemo(() => ({ scope, setScope }), [scope, setScope]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeckScope(): DeckScopeValue {
  return useContext(Ctx);
}
