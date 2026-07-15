/**
 * Deterministic card rarity for completed-task cards (issue #62): completing
 * high-leverage work while it was on the drawn card is the behavior this app
 * exists to reward, so those completions get rare-card aesthetics. Derived at
 * render time from facts the completion already carries — no randomness, no
 * stored rarity, no API surface (the ADR-2 / ADR-5 derived-state pattern):
 *
 *   foil    drawn AND impact 5   faint iridescent multi-hue sheen
 *   silver  drawn AND impact 4   faint monochrome silver sheen
 *   none    everything else     plain card
 *
 * This mirrors the XP semantics: completeTask() awards the 1.5x bonus off the
 * same was_drawn flag, and impact 4-5 implies a goal-linked task (ADR-4) —
 * foil literally means "drawn high-leverage completion". Because impact rides
 * the live tasks join (like title), editing a task's impact after completion
 * moves the rarity of today's card; accepted, consistent with the join.
 *
 * Shared by the trophy pile (TrophyDeck) and the History skyline's upright
 * cards (#53), whose payloads deliver `wasDrawn` differently — the pile as a
 * raw SQLite 0 | 1, the skyline as a boolean — hence the loose truthy check.
 */
export type TrophyRarity = "foil" | "silver" | "none";

export function trophyRarity(c: { wasDrawn: number | boolean; impact: number }): TrophyRarity {
  if (!c.wasDrawn) return "none";
  if (c.impact === 5) return "foil";
  if (c.impact === 4) return "silver";
  return "none";
}
