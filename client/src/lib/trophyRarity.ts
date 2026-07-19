/**
 * Deterministic card rarity for completed-task cards (issue #62): completing
 * high-leverage work while it was on the drawn card is the behavior this app
 * exists to reward, so those completions get rare-card aesthetics. Derived at
 * render time from facts the completion already carries — no randomness, no
 * stored rarity, no API surface (the ADR-2 / ADR-5 derived-state pattern):
 *
 *   holo    drawn AND impact 5   iridescent multi-hue shimmer (#123)
 *   silver  drawn AND impact 4   faint monochrome silver sheen
 *   none    everything else     plain card
 *
 * This mirrors the XP semantics: completeTask() awards the 1.5x bonus off the
 * same was_drawn flag, and impact 4-5 implies a goal-linked task (ADR-4) —
 * holo literally means "drawn high-leverage completion". The wasDrawn these
 * payloads carry is already `was_drawn AND NOT was_warmup` server-side: a
 * warm-up deal (#57, ADR-30) was handed out, not gambled, and mints no
 * rarity — display and XP agree on what counts as drawn. Because impact rides
 * the live tasks join (like title), editing a task's impact after completion
 * moves the rarity of today's card; accepted, consistent with the join.
 *
 * Shared by the trophy pile (TrophyDeck) and the Stats skyline's upright
 * cards (#53), whose payloads deliver `wasDrawn` differently — the pile as a
 * raw SQLite 0 | 1, the skyline as a boolean — hence the loose truthy check.
 */
export type TrophyRarity = "holo" | "silver" | "none";

export function trophyRarity(c: { wasDrawn: number | boolean; impact: number }): TrophyRarity {
  if (!c.wasDrawn) return "none";
  if (c.impact === 5) return "holo";
  if (c.impact === 4) return "silver";
  return "none";
}
