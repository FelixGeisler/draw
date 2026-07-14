# 10. Quality Requirements

[← back to index](index.md)

## 10.1 Quality Tree

Priorities from [section 1.2](01_introduction_and_goals.md): local zero-friction >
AI degradation > data integrity > cost transparency > responsiveness.

## 10.2 Quality Scenarios

| # | Scenario | Expected behavior |
|---|---|---|
| Q1 | User has no `ANTHROPIC_API_KEY` | All non-AI features fully functional; AI buttons hidden; AI endpoints return 503 with a helpful message |
| Q2 | API key is invalid/revoked | Friendly error ("key was rejected — check server/.env"), no crash, no stack trace in the UI |
| Q3 | User selects a semester of lecture PDFs | Estimate shows token count + cost first; requests over 180K input tokens rejected with "deselect some materials" |
| Q4 | Same materials, second AI call within 5 min | Prompt cache hit — `cache_read_input_tokens > 0`, ~10% of first-call input cost |
| Q5 | Timer running, browser closed and reopened | TimerBar restores from server state; elapsed time correct |
| Q6 | Two timers started in sequence | First entry auto-closed in the same transaction; never two running entries |
| Q7 | Parent task completed while subtasks open | 409 with "complete all subtasks first" |
| Q8 | Task reopened after completion | Latest completion row removed — XP cannot be farmed |
| Q9 | Draw with only oversized tasks left | `all_too_big` reason → UI links to breakdown, not a dead end |
| Q10 | 40 draws over a mixed deck | High-impact/low-effort tasks visibly dominate; due-today tasks outdraw higher-impact undated ones; 1★ slogs are rare |
| Q11 | Server killed mid-write | SQLite WAL keeps the database consistent |
| Q12 | Fresh checkout on a new Windows machine | `npm install && npm run dev` works without a compiler toolchain (prebuilt binaries) |

Q1, Q3 (guardrail), Q6–Q10 are covered by the automated test suites (unit /
integration / E2E — see [8.7](08_crosscutting_concepts.md)) and run in CI on every
PR. Q2 and Q4 need a live API key and are verified manually; Q5 is covered by the
E2E timer journey; Q11/Q12 are properties of SQLite WAL and prebuilt binaries.
