# 2. Architecture Constraints

[← back to index](index.md)

| Constraint | Background |
|---|---|
| Local-only, single user | Runs on the owner's Windows 11 PC; no accounts, no sync, no server deployment |
| Windows compatibility | Native dependencies must ship prebuilt win32 binaries (better-sqlite3 does) |
| Node.js 22+ | better-sqlite3 prebuilds and modern ESM; developed on Node 24 |
| API key stays server-side | `ANTHROPIC_API_KEY` lives in `server/.env`, never reaches the browser |
| No over-engineering | No auth, no Docker, no CI pipelines, no ORM, no Redux — deliberate guardrails for a personal project |
| Issue-driven workflow | Every change via GitHub issue + PR; branches `<IssueID>_Name`; commits `#<IssueId> Message` |
| Claude API usage rules | Model `claude-opus-4-8`; adaptive thinking; structured outputs via `messages.parse()`; no `temperature`/`budget_tokens`/assistant prefill (rejected by the model) |
| Documentation | arc42, hosted via GitHub Pages from `docs/` on `main` |
