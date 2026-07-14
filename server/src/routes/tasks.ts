import { Router } from "express";
import { db } from "../db.js";
import {
  completeTask,
  undoLatestCompletion,
  wasRecentlyDrawn,
  type TaskRow,
} from "../services/gamificationService.js";
import { startTimer } from "./timer.js";

export const tasksRouter = Router();

const TASK_SELECT = `
  SELECT id, title, description,
         category_id AS categoryId, goal_id AS goalId, parent_id AS parentId,
         impact, effort_minutes AS effortMinutes, due_date AS dueDate,
         recur_every_days AS recurEveryDays, status,
         created_at AS createdAt, completed_at AS completedAt,
         last_drawn_at AS lastDrawnAt,
         EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status = 'open') AS hasOpenChildren
  FROM tasks`;

function getTask(id: number) {
  return db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

tasksRouter.get("/", (req, res) => {
  const status = (req.query.status as string) || "open";
  const conditions: string[] = ["parent_id IS NULL"];
  const params: unknown[] = [];

  if (status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }
  if (req.query.categoryId) {
    conditions.push("category_id = ?");
    params.push(Number(req.query.categoryId));
  }
  if (req.query.goalId) {
    conditions.push("goal_id = ?");
    params.push(Number(req.query.goalId));
  }

  const roots = db
    .prepare(`${TASK_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`)
    .all(...params) as Record<string, unknown>[];

  const childStmt = db.prepare(
    `${TASK_SELECT} WHERE parent_id = ? AND status != 'archived' ORDER BY created_at ASC`,
  );
  for (const root of roots) {
    root.subtasks = childStmt.all(root.id);
  }
  res.json(roots);
});

tasksRouter.post("/", (req, res) => {
  const { title, description, categoryId, goalId, parentId, impact, effortMinutes, dueDate, recurEveryDays } =
    req.body ?? {};
  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  if (!categoryId) {
    return res.status(400).json({ error: "categoryId is required" });
  }
  const result = db
    .prepare(
      `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, due_date, recur_every_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      title.trim(),
      description ?? null,
      categoryId,
      goalId ?? null,
      parentId ?? null,
      impact ?? 3,
      effortMinutes ?? null,
      dueDate ?? null,
      recurEveryDays ?? null,
      new Date().toISOString(),
    );
  res.status(201).json(getTask(Number(result.lastInsertRowid)));
});

tasksRouter.post("/:id/subtasks", (req, res) => {
  const parent = getTask(Number(req.params.id));
  if (!parent) return res.status(404).json({ error: "task not found" });

  const subtasks = req.body?.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return res.status(400).json({ error: "subtasks array is required" });
  }
  for (const s of subtasks) {
    if (!s.title || typeof s.title !== "string" || !s.title.trim()) {
      return res.status(400).json({ error: "every subtask needs a title" });
    }
  }

  const insert = db.prepare(
    `INSERT INTO tasks (title, category_id, goal_id, parent_id, impact, effort_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const created = db.transaction(() => {
    const ids: number[] = [];
    for (const s of subtasks) {
      const r = insert.run(
        s.title.trim(),
        parent.categoryId,
        parent.goalId ?? null,
        parent.id,
        s.impact ?? parent.impact,
        s.effortMinutes ?? null,
        new Date().toISOString(),
      );
      ids.push(Number(r.lastInsertRowid));
    }
    return ids.map((id) => getTask(id));
  })();

  res.status(201).json(created);
});

tasksRouter.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const raw = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!raw) return res.status(404).json({ error: "task not found" });

  const body = req.body ?? {};

  // Completion goes through the gamification path.
  if (body.status === "done" && raw.status === "open") {
    const openChildren = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'open'")
      .get(id) as { n: number };
    if (openChildren.n > 0) {
      return res.status(409).json({ error: "complete all subtasks first" });
    }
    const drawn = body.wasDrawn !== undefined ? Boolean(body.wasDrawn) : wasRecentlyDrawn(raw);
    const result = db.transaction(() => completeTask(raw, drawn))();
    return res.json({ task: getTask(id), ...result });
  }

  // Reopening: undo the latest completion so XP stays honest.
  if (body.status === "open" && raw.status === "done") {
    db.transaction(() => {
      undoLatestCompletion(id);
      db.prepare("UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?").run(id);
    })();
    return res.json({ task: getTask(id) });
  }

  const fields: Record<string, string> = {
    title: "title",
    description: "description",
    categoryId: "category_id",
    goalId: "goal_id",
    impact: "impact",
    effortMinutes: "effort_minutes",
    dueDate: "due_date",
    recurEveryDays: "recur_every_days",
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

  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  res.json({ task: getTask(id) });
});

tasksRouter.post("/:id/timer/start", (req, res) => {
  const result = startTimer(Number(req.params.id));
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ ok: true });
});

tasksRouter.delete("/:id", (req, res) => {
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: "task not found" });
  res.json({ ok: true });
});
