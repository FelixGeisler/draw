import { Router } from "express";
import { db } from "../db.js";
import { checkAchievements } from "../services/gamificationService.js";
import { notifyGoalAchieved, notifyUnlocks } from "../services/notifyService.js";
import { MINUTES_EXPR } from "../services/statsService.js";

export const goalsRouter = Router();

// Goal resolution (#145, ADR-38): the schema CHECK would reject an unknown
// status anyway, but as an unhandled 500 — validate here for a clean 400.
// All transitions are legal (reactivation included): a state machine protects
// no invariant in a single-user app with one writer.
const GOAL_STATUSES = ["active", "achieved", "missed", "dropped"];

// Feasibility inputs (#60), derived at query time like the counts — no new
// columns, nothing stored (ADR-2/ADR-5):
// - remainingOpenEffortMinutes sums estimates over the goal's open LEAF tasks
//   (zero non-archived subtasks, #111/ADR-32) only. Subtasks inherit goal_id
//   (#29), so a naive goal_id sum would count a broken-down parent's estimate
//   on top of its children's — the same no-double-counting rule as the tasks
//   list's remainingEffortMinutes (PR #26); and a parent whose breakdown is
//   all done (a recurring parent stays open in that state) has no remaining
//   work of its own, so its stored estimate stays out too. NULL when no open
//   leaf is estimated.
// - totalEffortMinutes (#229) is the same leaf rule over open AND done leaves
//   — the boss bar's max HP, of which remainingOpenEffortMinutes is what still
//   stands. Remaining <= total by construction (same leaves, same NULL skips),
//   so the HP fraction can never overflow. Archived leaves stay out of both:
//   a split-in-place original (ADR-21) was replaced, not defeated.
// - trackedMinutes14d reuses the stats MINUTES_EXPR so a running entry counts
//   up to now (#22); the window filter compares ISO strings lexicographically,
//   like every stats range filter.
const GOAL_SELECT = `
  SELECT g.id, g.title, g.outcome, g.target_date AS targetDate, g.status, g.created_at AS createdAt,
         g.resolved_at AS resolvedAt,
         (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status != 'archived') AS taskCount,
         (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status = 'done') AS doneCount,
         (SELECT COUNT(*) FROM materials m WHERE m.goal_id = g.id) AS materialCount,
         (SELECT SUM(t.effort_minutes) FROM tasks t
            WHERE t.goal_id = g.id AND t.status = 'open'
              AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status != 'archived')
         ) AS remainingOpenEffortMinutes,
         (SELECT SUM(t.effort_minutes) FROM tasks t
            WHERE t.goal_id = g.id AND t.status != 'archived'
              AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status != 'archived')
         ) AS totalEffortMinutes,
         (SELECT CAST(ROUND(COALESCE(SUM(${MINUTES_EXPR}), 0)) AS INTEGER)
            FROM time_entries e JOIN tasks t ON t.id = e.task_id
            WHERE t.goal_id = g.id
              AND e.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
         ) AS trackedMinutes14d
  FROM goals g`;

function getGoal(id: number) {
  return db.prepare(`${GOAL_SELECT} WHERE g.id = ?`).get(id);
}

goalsRouter.get("/", (req, res) => {
  const status = (req.query.status as string) || "active";
  const where = status === "all" ? "" : "WHERE g.status = ?";
  const params = status === "all" ? [] : [status];
  res.json(db.prepare(`${GOAL_SELECT} ${where} ORDER BY g.created_at DESC`).all(...params));
});

goalsRouter.post("/", (req, res) => {
  const { title, outcome, targetDate } = req.body ?? {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  const r = db
    .prepare("INSERT INTO goals (title, outcome, target_date, created_at) VALUES (?, ?, ?, ?)")
    .run(title.trim(), outcome ?? null, targetDate ?? null, new Date().toISOString());
  res.status(201).json(getGoal(Number(r.lastInsertRowid)));
});

goalsRouter.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if ("status" in body && !GOAL_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: `status must be one of ${GOAL_STATUSES.join(", ")}` });
  }
  const existing = db
    .prepare("SELECT status, resolved_at AS resolvedAt FROM goals WHERE id = ?")
    .get(id) as { status: string; resolvedAt: string | null } | undefined;
  if (!existing) return res.status(404).json({ error: "goal not found" });
  const fields: Record<string, string> = {
    title: "title",
    outcome: "outcome",
    targetDate: "target_date",
    status: "status",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) {
      sets.push(`${column} = ?`);
      params.push(body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "nothing to update" });
  if ("status" in body) {
    // resolved_at is the EVENT FACT of leaving 'active' (ADR-38), maintained
    // server-side only: set once on the transition out, kept verbatim across
    // resends and achieved<->missed corrections (so a pre-v12 resolved row
    // keeps its honest NULL instead of minting a bogus date), cleared on
    // reactivation.
    sets.push("resolved_at = ?");
    params.push(
      body.status === "active"
        ? null
        : existing.status === "active"
          ? new Date().toISOString()
          : existing.resolvedAt,
    );
  }
  db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  // First transition into 'achieved' can unlock first_goal. The condition is
  // state-derived inside checkAchievements (an achieved goal exists), like
  // first_completion — the gate here only keeps plain goal edits from probing
  // achievements on every save. Additive optional response field, the same
  // newAchievements convention as the draw/tasks routes.
  const achieved = body.status === "achieved" && existing.status !== "achieved";
  const newAchievements = achieved ? checkAchievements({}) : [];
  const goal = getGoal(id) as Record<string, unknown>;
  // Post-commit (#235): the status write above is done; a felled goal and
  // any unlock it caused are facts worth a ping.
  if (achieved) notifyGoalAchieved(String(goal.title));
  notifyUnlocks(newAchievements);
  res.json(newAchievements.length ? { ...goal, newAchievements } : goal);
});

goalsRouter.delete("/:id", (req, res) => {
  const r = db.prepare("DELETE FROM goals WHERE id = ?").run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: "goal not found" });
  res.json({ ok: true });
});
