# 4. Solution Strategy

[← back to index](index.md)

| Problem | Strategy |
|---|---|
| Decision paralysis | A single **weighted random draw** replaces choosing. The weight formula encodes the product's opinion: leverage and urgency beat comfort. |
| Big tasks never get started | **Drawability is a derived predicate**, not a flag: `status='open' AND effort ≤ max AND no open children`. Oversized tasks simply never appear in the deck — the UI funnels them into breakdown. |
| Low-leverage time use | Impact ratings only exist on goal-linked tasks (leverage is *toward* something). Time tracking joins `time_entries × tasks` and aggregates minutes by impact; rule-based insights and a weekly A–F grade make the pattern visible. |
| Motivation | Gamification derived entirely from the `completions` table (XP, streaks, achievements) — no stored counters that can drift. Completing the *drawn* card pays 1.5× XP, reinforcing the core mechanic. |
| Planning quality | Optional Claude API layer with **structured outputs** (zod schemas), fed by user-selected goal materials (PDFs as native document blocks). Prompt design encodes the anti-procrastination stance: first subtask must be near-zero activation energy; practicing what is graded beats passive reading. |
| Trust & cost | Token counting before every AI call; user confirms after seeing "~85K tokens ≈ $0.45". Prompt caching (cache breakpoint after materials) makes repeated calls ~10% of first-call cost. |

**Technology choices** (rationale in [section 9](09_architecture_decisions.md)):
React + TypeScript + Vite client, Express 5 + better-sqlite3 server, npm workspaces,
TanStack Query for server state, `@anthropic-ai/sdk` server-side only.
