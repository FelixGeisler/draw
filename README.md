# 🃏 Draw — Task Planner

A local, single-user task planner that fights procrastination two ways:

- **Getting started:** big tasks must be broken into ≤30-minute steps before they enter the deck. Hit **Draw** and a weighted-random card tells you what to do *right now* — no choosing, no stalling.
- **Leverage:** goal-linked tasks carry an impact rating (1–5★). The draw favors high-impact, low-effort, urgent tasks; the stats page shows where your time really went, broken down by impact, category, and goal. AI planning derives tasks backward from what actually gets measured ("the exam tests X — start there").

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

## Use it from Claude Code / Claude Desktop (MCP)

Draw ships an [MCP](https://modelcontextprotocol.io/) server that exposes the domain
operations — list/create/complete tasks, break them down, draw a card, timers, stats,
goals and materials — so you can say *"what should I do right now?"* or *"import this
exam as tasks"* from a conversation. It is a thin adapter over the same local HTTP API
the web UI uses (ADR-19), so every domain rule holds identically.

- The app must be running (`npm run dev`); the MCP server talks to
  `http://127.0.0.1:3001` (override with `DRAW_API_URL`).
- Needs **no** `ANTHROPIC_API_KEY` — the intelligence is the MCP client's.
- No delete tools are exposed, and your MCP client asks you to approve each write.
- Resources for context: `draw://deck` (drawable pool snapshot), `draw://gamification`
  (XP/streak/achievements), `draw://materials/{id}` (goal notes and PDFs).

**Claude Code** picks up the committed [`.mcp.json`](.mcp.json) automatically when you
open this repo — approve the `draw` server when prompted, then try
*"draw me a card"*.

**Claude Desktop**: add the server to `claude_desktop_config.json` with an absolute
path to your checkout, e.g. on Windows:

```json
{
  "mcpServers": {
    "draw": {
      "command": "cmd",
      "args": ["/c", "npm", "run", "-s", "mcp", "-w", "server", "--prefix", "C:/path/to/draw"]
    }
  }
}
```

(macOS/Linux: `"command": "npm"`, `"args": ["run", "-s", "mcp", "-w", "server", "--prefix", "/path/to/draw"]`.)

## How the draw weighting works

```
weight = impact² / effort × urgency × staleness
```

- `impact²` — a 5★ task is ~25× likelier than a 1★ at equal effort
- `÷ effort` — quick wins float up
- `urgency` — ramps ×1→×4 in the last 7 days before the due date, ×5 when overdue
- `staleness` — the longer a task sits (or a chore goes undone), the louder it gets (up to ×2)
- recently drawn cards are dampened ×0.15 for an hour, so successive draws give variety

## Documentation

Architecture documentation ([arc42](https://arc42.org/), AsciiDoc/[Antora](https://antora.org/))
lives in [`docs/`](docs/modules/ROOT/pages) and is hosted at
**https://felixgeisler.github.io/draw/**. Build locally with `npm run docs:build`.
Diagrams are inline PlantUML rendered at build time by [Kroki](https://kroki.io/),
so a docs build needs network access to kroki.io — but no local PlantUML or Java.
Workflow conventions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

React + TypeScript + Vite · TanStack Query · Express 5 · better-sqlite3 · @anthropic-ai/sdk (claude-opus-4-8, structured outputs, prompt caching) · @modelcontextprotocol/sdk (MCP server over stdio)
