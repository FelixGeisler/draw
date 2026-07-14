# 🃏 Draw — Task Planner

A local, single-user task planner that fights procrastination two ways:

- **Getting started:** big tasks must be broken into ≤30-minute steps before they enter the deck. Hit **Draw** and a weighted-random card tells you what to do *right now* — no choosing, no stalling.
- **Leverage:** goal-linked tasks carry an impact rating (1–5★). The draw favors high-impact, low-effort, urgent tasks; the stats page shows where your time really went and grades your week (A–F). AI planning derives tasks backward from what actually gets measured ("the exam tests X — start there").

Plus: due dates, recurring chores, time tracking, XP + levels, streaks, achievements, confetti.

## Run it

```
npm install
npm run dev
```

Open http://localhost:5173. Data lives in `server/data/app.db` (SQLite).

Requires Node.js 22+ (built with Node 24).

## Enable AI features (optional)

Copy `server/.env.example` to `server/.env` and set `ANTHROPIC_API_KEY` (get one at
https://platform.claude.com/). Restart. This enables:

- **✨ Suggest with AI** — breaks a big task into small, startable steps
- **✨ Plan backward** — analyzes a goal's measured outcome and proposes high-leverage tasks,
  using the PDFs/notes you attach to the goal (lectures, past exams, syllabus)

Every AI call shows a token/cost estimate first and requires your confirmation. Everything
else works without a key.

## How the draw weighting works

```
weight = impact² / effort × urgency × staleness
```

- `impact²` — a 5★ task is ~25× likelier than a 1★ at equal effort
- `÷ effort` — quick wins float up
- `urgency` — ramps ×1→×4 in the last 7 days before the due date, ×5 when overdue
- `staleness` — the longer a task sits (or a chore goes undone), the louder it gets (up to ×2)
- recently drawn cards are dampened ×0.15 for an hour, so "Draw again" gives variety

## Stack

React + TypeScript + Vite · TanStack Query · Express 5 · better-sqlite3 · @anthropic-ai/sdk (claude-opus-4-8, structured outputs, prompt caching)
