# 6. Runtime View

[← back to index](index.md)

## 6.1 Drawing a card

```
User          Client (DrawPage)        Server (drawService)
 │ click card      │                        │
 │────────────────►│ POST /api/draw         │
 │                 │───────────────────────►│ select drawable candidates
 │                 │  (shuffle animation)   │ weight = impact²/effort
 │                 │                        │   × urgency × staleness × cooldown
 │                 │                        │ roulette pick, set last_drawn_at
 │                 │◄───────────────────────│ {task, poolSize, probability}
 │ card flips      │ + achievement check    │
```

Empty pool returns `{task: null, reason: 'no_ready_tasks' | 'all_too_big'}` —
the UI turns this into a "break something down" call to action.

## 6.2 Completing a task (single transaction)

```
PATCH /api/tasks/:id {status: 'done', wasDrawn?}
  ├─ reject 409 if open subtasks exist
  ├─ wasDrawn omitted → derived: last_drawn_at within 6h
  └─ transaction:
       insert completions row (xp = effort × impact/3, ×1.5 if drawn)
       recurring? push due_date forward : set status done
       check achievements → response {task, xpAwarded, newAchievements, levelUp}
```

The client fires confetti, updates the trophy deck, and toasts new achievements
from this single response.

## 6.3 AI backward planning (with materials)

```
User picks materials → POST /api/ai/estimate
                        └─ count_tokens on assembled request → {inputTokens, estimatedUsd}
User confirms        → POST /api/ai/plan-goal {goalId, materialIds, userNotes?}
                        ├─ 503 if no API key; 400 if > 180K input tokens
                        ├─ blocks: [materials (PDFs as document blocks,
                        │           cache_control on last), goal context + instructions]
                        ├─ messages.parse(model=claude-opus-4-8, adaptive thinking,
                        │                 output_config.format = zod schema)
                        └─ {outcomeAnalysis, tasks[{title, effort, impact, phase}]}
User reviews/edits/deselects → accepted tasks created via POST /api/tasks
```

Nothing is written to the database without explicit user confirmation.

## 6.4 Timer invariant

`POST /api/tasks/:id/timer/start` closes any running entry and opens a new one in
one transaction — at most one `time_entries` row with `ended_at IS NULL` exists.
The TimerBar restores itself after reload from `GET /api/timer/current`.
