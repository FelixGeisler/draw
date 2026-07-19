// Pure helpers for the achievement display-customization UI (#177, ADR-44).
// Kept out of the component so the collection split and the edit-form wiring
// are unit-testable without a DOM (the client suite has no renderer) — the same
// pattern as lib/achievementRarity and lib/drawnCard.

/** The edit fields the inline card editor collects. */
export interface AchievementDraft {
  title: string;
  description: string;
  hidden: boolean;
}

/** The PATCH body /api/achievements/:key accepts. */
export interface AchievementPatchBody {
  title: string | null;
  description: string | null;
  hidden: boolean;
}

/**
 * Build the PATCH body from the editor draft. A trimmed-empty title/description
 * becomes null — "use the server default" — so clearing an input in the editor
 * resets that field rather than storing a blank override (the server normalizes
 * the same way, but the client sends the honest intent). Whitespace is trimmed
 * off the kept value too.
 */
export function buildAchievementPatch(draft: AchievementDraft): AchievementPatchBody {
  const title = draft.title.trim();
  const description = draft.description.trim();
  return {
    title: title.length > 0 ? title : null,
    description: description.length > 0 ? description : null,
    hidden: draft.hidden,
  };
}

/**
 * The "reset to default" PATCH: clears both text overrides AND un-hides. The
 * server deletes the now-all-default row, so the card reverts to its shipped
 * title/description and returns to the main collection.
 */
export function resetAchievementPatch(): AchievementPatchBody {
  return { title: null, description: null, hidden: false };
}

/**
 * Split achievements into the main collection and the curated-away "Hidden"
 * section. Hiding is DISPLAY curation only (never deletion, never affects
 * unlock/claim/XP) — a hidden card is still editable, claimable and
 * un-hideable from its section. Order within each bucket is preserved.
 */
export function partitionAchievements<T extends { hidden: boolean }>(
  achievements: T[],
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const a of achievements) (a.hidden ? hidden : visible).push(a);
  return { visible, hidden };
}
