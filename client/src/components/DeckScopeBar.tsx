import { useDeckScope } from "../DeckScopeContext";
import { useCategories } from "../hooks/useTasks";
import "./DeckScopeBar.css";

/**
 * The work-mode indicator (#214).
 *
 * Renders NOTHING when the whole deck is in play, so the unscoped app gains no
 * permanent chrome. When a scope is set it is always visible, because the
 * failure mode this exists to prevent is a scoped app being mistaken for an
 * empty one: a filtered Tasks page and a small deck look exactly like having
 * finished everything, and the scope survives reloads, so there is no natural
 * moment where the user is reminded they set it.
 *
 * The ✕ is the one-click way out, in every corner of the app rather than only
 * on the Draw page where the chips live.
 */
export function DeckScopeBar() {
  const { scope, setScope } = useDeckScope();
  const categories = useCategories();
  if (scope == null) return null;
  const category = categories.data?.find((c) => c.id === scope);
  if (!category) return null;

  return (
    <div className="deck-scope-bar" data-testid="deck-scope-bar">
      <span className="dot" style={{ background: category.color }} />
      <span>
        Working on <strong>{category.name}</strong> only
      </span>
      <button
        onClick={() => setScope(undefined)}
        title="Show every category again"
        aria-label="Clear work mode — show every category"
      >
        ✕
      </button>
    </div>
  );
}
