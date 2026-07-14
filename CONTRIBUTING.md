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

## Documentation

Architecture documentation follows [arc42](https://arc42.org/) and lives in `docs/`,
hosted via GitHub Pages. Keep it current: architectural decisions belong in
section 9 (Architecture Decisions), new quality requirements in section 10.
