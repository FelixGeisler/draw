<div align="center">

<img src="client/public/icons/icon-512.png" alt="" width="104">

# Draw

**Stop choosing. Draw one small task and just start.**

A self-hosted task planner for the days when you know exactly what needs doing
and open a to-do list instead.

<img src=".github/assets/draw.png" alt="A drawn card: a 30-minute task with its category and impact rating, and the actions to start, finish or put it back" width="820">

</div>

## The idea

Picking the next task *is* the procrastination. So Draw takes the pick away
from you.

Nothing enters the deck until it is small — an estimate, and under 30 minutes
by default. Then you hit **Draw** and one card comes up. Not a list, not a
prioritised backlog, not tomorrow's plan. One card, face up, and the only ways
out are to do it, put it back, or drop it. **There is no "draw again"** — a
re-roll would just be choosing with extra steps.

The pick is weighted, so it is random without being stupid:

```
weight = impact² / effort × urgency × staleness
```

A 5★ task is ~25× likelier than a 1★ at the same size, quick wins float up,
anything with a deadline gets loud in its final week, and neglected chores
climb on their own. Cards you just drew are damped for an hour, so consecutive
draws feel different.

## What else is in the box

- **Goals with a measured outcome.** Not "get better at ML" — *"pass with 80%"*.
  Tasks link to a goal and carry a 1–5★ impact rating, and a burn-down chip
  tells you when a goal has quietly become infeasible.
- **Break anything down.** Split a task into startable steps by hand, or let
  Claude read the lecture PDFs and past exams you attached and propose the
  steps that actually move the outcome.
- **XP, levels, streaks, achievements.** Finishing a card you drew pays more
  than one you picked. Streaks respect your rest days, and bank a freeze for
  when life happens.
- **A trophy deck and a history calendar**, because finishing things should
  leave a mark.
- **Time tracking and a focus view** — one card, one clock, and nothing
  auto-fails when the estimate runs out.
- **Talk to it from Claude.** Draw ships an MCP server, so *"what should I do
  right now?"* and *"import this syllabus as tasks"* work from a conversation.

## Try it

```bash
npm install && npm run dev
```

Open http://localhost:5173. Data lives in `server/data/app.db` (SQLite).
Requires Node.js 22+.

## Run it for real

Self-host on a Raspberry Pi or any home server — one container, one volume:

```bash
docker compose up -d
```

Set `DRAW_PASSWORD` before putting it on a network, and put
[Tailscale](https://tailscale.com) in front for HTTPS — which is also what
makes it installable as a phone app. Both are a few lines in
[`docker-compose.yml`](docker-compose.yml); the
**[deployment guide](https://felixgeisler.github.io/draw/docs/07_deployment_view.html)**
has the details, along with backups, upgrades, prebuilt images and the MCP
client setup.

AI features stay off until you add an `ANTHROPIC_API_KEY` — and every call
shows a cost estimate and waits for your confirmation. Everything else works
without one.

## Under the hood

React · TypeScript · Vite · TanStack Query · Express 5 · SQLite
(better-sqlite3) · the Claude API for planning · MCP over stdio.

Derived state over stored state: drawability, XP, levels and streaks are
computed from the facts, never kept as counters.

**[Architecture documentation](https://felixgeisler.github.io/draw/)** —
[arc42](https://arc42.org/), a stack of decision records, and why each one went
the way it did. Contributing conventions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
