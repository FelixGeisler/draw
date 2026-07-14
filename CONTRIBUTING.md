# Contributing / Workflow

This project follows a strict issue-driven workflow — for humans and AI agents alike.

## Rules

1. **Every change starts with a GitHub issue.** No direct commits to `main`.
2. **Branches** are named `<IssueID>_BranchName`, e.g. `12_fix-draw-cooldown`.
3. **Commits** reference the issue: `#<IssueId> Commit Message`, e.g. `#12 Dampen repeat draws within cooldown`.
4. **Pull requests** close their issue (`Closes #<IssueId>` in the description) and are merged with a merge commit (so issue-referencing commits stay in history).

## Development

```
npm install
npm run dev        # Express :3001 + Vite :5173
```

Type checks: `npm run build -w server` and `npx tsc --noEmit -p client/tsconfig.json`.

## Tests — required for every PR

Three levels; all must be green before a PR is merged (CI enforces this):

| Level | Command | What it covers |
|---|---|---|
| Unit | `npm test` (part 1) | Pure logic: draw weights, XP/levels, drawability classification |
| Integration | `npm test` (part 2) | REST API against a real temp SQLite DB (supertest) |
| End-to-end | `npm run test:e2e` | Full user journeys in a real browser (Playwright, own ports + throwaway DB) |

One-time setup for E2E: `npx playwright install chromium`.

Tests never touch your real database — they run against temp directories via the
`DATA_DIR` environment variable. New features need tests at the appropriate level:
domain logic → unit, API behavior → integration, user-visible flows → E2E.

## Documentation

Architecture documentation follows [arc42](https://arc42.org/) and lives in
`docs/modules/ROOT/pages/` (AsciiDoc, built with [Antora](https://antora.org/)
— `npm run docs:build`, output in `build/site/`). It deploys to GitHub Pages via
the `Docs` workflow on every push to `main` that touches `docs/`. Keep it
current: architectural decisions belong in section 9 (Architecture Decisions),
new quality requirements in section 10.
