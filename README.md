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

### Production mode

```
npm run build
npm start
```

One process, one port: Express serves the built client (`client/dist`) and the
API together at http://127.0.0.1:3001 (`API_PORT` to change it). Both modes use
the same `server/data/`. By default the server is only reachable from the local
machine; set `HOST=0.0.0.0` in `server/.env` to expose production mode on your
network (`npm run dev` always stays local).

When you expose it, also set `DRAW_PASSWORD` in `server/.env`: every page and
API request then requires logging in once per browser (a signed cookie, valid
30 days). Without it, anyone on the network can read your tasks — and your
Anthropic API key. Failed logins are rate-limited per client. Draw serves
plain HTTP; if you want TLS, terminate HTTPS in a reverse proxy (Caddy, nginx)
in front of it — and set `TRUST_PROXY=loopback` so the rate limiter still sees
each real client.

### Self-host with Docker (Raspberry Pi)

The 1.0.0 way to run Draw on a home server or Raspberry Pi is a container. The
image is multi-arch (`linux/arm64` for the Pi, `linux/amd64` for a desktop),
runs the production server as a non-root user, and keeps all your data on a
named volume.

The simplest path — build and run in one step:

```
docker compose up -d
```

That builds the image locally (arm64 on a Pi), starts it, mounts the
`draw-data` volume, and wires the healthcheck. Open `http://<host-ip>:3001`.
Your tasks, materials, and database live on the volume and survive
`docker compose down`, recreation, and upgrades.

**Set a password.** The container listens on your LAN (`HOST=0.0.0.0`), so
uncomment `DRAW_PASSWORD` in [`docker-compose.yml`](docker-compose.yml) before
exposing it — otherwise anyone on the network can read your tasks and your
Anthropic API key. Behind a reverse proxy, also set `TRUST_PROXY` (e.g.
`loopback`).

**Build both architectures explicitly** (e.g. to build on a fast amd64 machine
for a Pi) with buildx:

```
docker buildx build --platform linux/amd64,linux/arm64 -t draw:latest .
```

**Or pull a prebuilt image** instead of building. Every release publishes a
multi-arch image to the GitHub Container Registry:

```
docker pull ghcr.io/felixgeisler/draw:latest      # newest final release
docker pull ghcr.io/felixgeisler/draw:1.0.0       # a specific version
```

Point Compose at it by dropping `build:` and setting
`image: ghcr.io/felixgeisler/draw:latest` in [`docker-compose.yml`](docker-compose.yml),
or `docker run` it directly (map the port, mount a volume at `/data`).

**Upgrade:** `docker pull` (or rebuild) the image, then recreate the container —
the `draw-data` volume carries your data across. **Backup/restore:** use the
export/import zip in Settings, or snapshot the `draw-data` volume. Data lives
under `/data` (`DATA_DIR`) inside the container.

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
- Against a password-protected instance, set `DRAW_PASSWORD` in `server/.env`
  (or the MCP process env) — the adapter sends it as a header automatically.
  The committed `.mcp.json` never contains the secret.
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
