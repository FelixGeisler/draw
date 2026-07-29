import { Link } from "react-router-dom";

/**
 * Why the candidate pool came up empty, in words — the four reasons the
 * SERVER's shared `emptyPoolReason` can return (drawService), kept as one
 * voice for one server-side predicate.
 *
 * Every link leads to the Tasks page (#151): capture, estimating, and
 * breaking down all live there now, so each named action exists where the
 * link lands.
 *
 * Draw-only reasons (`cooling_down`, `warmup_unavailable`) stay at their call
 * site: they describe the warm-up allowance, not the pool.
 */
export function EmptyPoolReason({
  reason,
}: {
  reason?:
    | "no_ready_tasks"
    | "all_too_big"
    | "all_outside_window"
    | "all_awaiting_next_occurrence";
}) {
  if (reason === "all_awaiting_next_occurrence") {
    // Not "already done this cycle": a recurring card that has NEVER been
    // completed lands here too — its entered due date is its first
    // occurrence (PR #206 review).
    return (
      <p>
        Everything left is waiting for its next occurrence — those{" "}
        <Link to="/tasks" style={{ color: "var(--accent)" }}>
          recurring cards
        </Link>{" "}
        come back on their own on the day they are next due.
      </p>
    );
  }
  if (reason === "all_outside_window") {
    return (
      <p>
        Everything left is scheduled for later — those cards come back on their own when their{" "}
        <Link to="/tasks" style={{ color: "var(--accent)" }}>
          availability window
        </Link>{" "}
        opens.
      </p>
    );
  }
  if (reason === "all_too_big") {
    return (
      <p>
        Everything left is too big or unestimated.{" "}
        <Link to="/tasks" style={{ color: "var(--accent)" }}>
          Break something down
        </Link>{" "}
        to refill the deck.
      </p>
    );
  }
  return (
    <p>
      The deck is empty.{" "}
      <Link to="/tasks" style={{ color: "var(--accent)" }}>
        Capture a task
      </Link>{" "}
      to get started.
    </p>
  );
}
