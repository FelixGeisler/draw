# 5. Building Block View

[← back to index](index.md)

## 5.1 Whitebox: Overall System

```
F:\Project (npm workspaces)
├── client/          React + TypeScript + Vite SPA
└── server/          Express 5 + better-sqlite3 + Claude API proxy
```

## 5.2 Whitebox: Server

```
server/src/
├── index.ts                 entry point: loads .env, listens on API_PORT
├── app.ts                   createApp() — Express app + router mounting (testable)
├── db.ts                    SQLite bootstrap, PRAGMA user_version migrations
├── schema.sql               Current full schema (fresh installs)
├── aiSchemas.ts             zod schemas for structured AI outputs
├── routes/                  HTTP layer (validation, status codes)
│   ├── tasks.ts             CRUD, subtask bulk-create, timer start, completion entry point
│   ├── categories.ts        CRUD (delete blocked while referenced)
│   ├── goals.ts             CRUD with task/material counts
│   ├── materials.ts         multer upload, download, delete (disk + row)
│   ├── timer.ts             current/stop; start lives on tasks route
│   ├── draw.ts              POST /api/draw
│   ├── stats.ts             GET /api/stats (UTC date-range handling)
│   ├── gamification.ts      GET /api/gamification
│   ├── settings.ts          key-value settings
│   └── ai.ts                status, estimate, breakdown, plan-goal
└── services/                Domain logic
    ├── drawService.ts       drawable predicate + weight formula + roulette selection
    ├── statsService.ts      SQL aggregations, leverage insights, weekly grade
    ├── gamificationService.ts  completion transaction, XP/levels/streaks, achievements
    └── aiService.ts         Anthropic client, material blocks, prompts, token guard
```

| Block | Responsibility | Key invariant |
|---|---|---|
| `drawService` | Candidate selection + weighting | Drawability is computed, never stored |
| `gamificationService` | Completion side-effects | XP/level/streak always derived from `completions` |
| `statsService` | Time aggregation | Running entries count up to *now*; date math in UTC |
| `aiService` | Claude API access | Requests blocked without key (503) or above 180K input tokens (400) |

## 5.3 Whitebox: Client

```
client/src/
├── api/client.ts + types.ts   typed fetch wrapper, shared DTOs
├── hooks/                     TanStack Query wrappers (useTasks, useDraw, useTimer,
│                              useGamification, useGoals, useAi)
├── pages/                     Draw (centerpiece, incl. the CSS-3D card flip), Capture,
│                              Tasks, Goals, Stats, Settings
└── components/                TaskRow/Form/Badges, SubtaskEditor, TimerBar,
                               GamificationHeader, TrophyDeck, AchievementToast,
                               MaterialsSection, AiSuggestionPanel (breakdown + plan panels)
```

All server state flows through TanStack Query; mutations invalidate the
`tasks`/`gamification`/`stats` query keys. There is no other state management.

## 5.4 Data Model

```
categories 1─n tasks n─1 goals 1─n materials
                │ 1─n time_entries
                │ 1─n completions        achievements (unlocked keys)
                └─ self-reference: parent_id (breakdown tree, depth 1)
                                         settings (key/value)
```

Central semantics: completing a **recurring** task keeps it `open` and pushes
`due_date` forward; completing a normal task sets `status='done'`. Both insert a
`completions` row — the single source for XP, streaks, trophy deck, and history.
