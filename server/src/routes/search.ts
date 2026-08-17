import { Router } from "express";
import { db } from "../db.js";

/**
 * Palette search (#243, ADR-68): GET /api/search?q= over task titles and goal
 * titles, one flat payload shaped for result rows — deliberately NOT the
 * TASK_SELECT projection (no deck-state columns, but joined category/goal
 * names the list route leaves to the client).
 *
 * Matching folds case AND diacritics by NFD-normalizing BOTH sides in JS:
 * SQLite's LIKE case-folds ASCII only (umlauts stay unmatched with a
 * Europe/Berlin user base) and this repo registers no custom db.function.
 * So the route selects broadly and filters here — a single-user DB makes a
 * full title scan cheap, and no index, FTS table or schema change is needed
 * (derived state over stored state, section 8). A user-typed % or _ matches
 * literally for free: there is no LIKE pattern to escape.
 *
 * Deck scope / work mode (ADR-57) is a client-side preference and must never
 * filter results — the palette exists to find what the deck hides. Subtasks
 * match by their own title for the same reason: GET /api/tasks hides them
 * behind their roots. Archived stays excluded: it is the soft-delete /
 * replaced-in-place state, not findable work.
 */
export const searchRouter = Router();

/** NFD-split, strip combining marks, lowercase: "Zubehör" → "zubehor". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

interface TaskHit {
  id: number;
  title: string;
  status: "open" | "done";
  effortMinutes: number | null;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  goalId: number | null;
  goalTitle: string | null;
}

interface GoalHit {
  id: number;
  title: string;
  status: string;
  openTaskCount: number;
}

const TASK_CAP = 20;
const GOAL_CAP = 10;

searchRouter.get("/", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q === "") {
    res.json({ tasks: [], goals: [] });
    return;
  }
  const needle = fold(q);

  // Open before done (live work before history) so the open group fills the
  // cap first; newest first within a group, mirroring the list route.
  const taskRows = db
    .prepare(
      `SELECT t.id, t.title, t.status,
              t.effort_minutes AS effortMinutes,
              t.category_id AS categoryId,
              c.name AS categoryName,
              c.color AS categoryColor,
              t.goal_id AS goalId,
              g.title AS goalTitle
       FROM tasks t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN goals g ON g.id = t.goal_id
       WHERE t.status != 'archived'
       ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END,
                t.created_at DESC, t.id DESC`,
    )
    .all() as TaskHit[];
  const tasks = taskRows.filter((t) => fold(t.title).includes(needle)).slice(0, TASK_CAP);

  // Goals of ANY status are searchable — a dropped ambition is still a thing
  // the user remembers by name. openTaskCount is derived per request, like
  // every count on GOAL_SELECT (ADR-2/ADR-5).
  const goalRows = db
    .prepare(
      `SELECT g.id, g.title, g.status,
              (SELECT COUNT(*) FROM tasks t
                WHERE t.goal_id = g.id AND t.status = 'open') AS openTaskCount
       FROM goals g
       ORDER BY g.created_at DESC`,
    )
    .all() as GoalHit[];
  const goals = goalRows.filter((g) => fold(g.title).includes(needle)).slice(0, GOAL_CAP);

  res.json({ tasks, goals });
});
