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

**Run `npm install` after every pull.** The workspaces are not self-healing: a
`node_modules` left over from an older commit crashes the server on boot with a
bare module-not-found (a missing runtime dependency looks nothing like "your
tree is stale"), and there is no postinstall hook or CI check that catches it
for you.

Vite comes up in under a second while the server is still running migrations,
so `npm run dev` waits for `GET /api/health` before proxying the first `/api`
call — one `waiting for … to finish booting…` line at start is expected, not an
error.

Type checks: `npm run build -w server` and `npx tsc --noEmit -p client/tsconfig.json`.

### Known dependency warnings (accepted — do not act on them)

`npm install` prints two deprecation warnings and `npm audit` reports six
moderate findings. All are **docs-toolchain-only** — neither the server nor the
client ships any of the packages involved — and none is currently actionable.
They are recorded here so the setup output does not look alarming and so this
analysis is not re-run each time someone notices it (issue #132).

- **`inflight@1.0.6` (memory leak) and `glob@8.1.0` (old, known CVEs)** arrive
  through `asciidoctor-kroki` → `@asciidoctor/core` → `@asciidoctor/opal-runtime`
  → `glob` → `inflight`. They cannot be overridden from our `package.json`
  without an `overrides` hack against a transitive Ruby-runtime shim; the fix has
  to come from upstream. `inflight`'s leak is irrelevant to a process that runs
  for a few seconds during `npm run docs:build` and then exits.
- **`js-yaml@4.1.1` — [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68)**
  (quadratic-complexity DoS in merge-key handling) accounts for all six audit
  findings, reached via `@antora/cli` and `@antora/site-generator`. npm's only
  offered remedy is downgrading `@antora/cli` 3.1.15 → 2.3.4 — a semver-major
  downgrade that would break the docs site (ADR-10) to avoid a DoS in a build
  tool that parses exactly one YAML file we author ourselves
  (`antora-playbook.yml`). No untrusted YAML enters the docs build, so the
  attack surface is none.

**Decision:** accept both, change no dependencies. Revisit when any of these holds:

- `asciidoctor-kroki` / `@asciidoctor/core` ship a release that drops the old
  `glob` chain → drop the `inflight`/`glob` note.
- Antora releases a version depending on a patched `js-yaml` (> 4.1.1) → upgrade
  and drop the advisory note.
- The advisory's severity is raised, or any of these packages enters the server
  or client runtime → act immediately.

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

Diagrams are code: PlantUML sources live inline in the `.adoc` pages inside
`[plantuml,<name>,svg]` blocks and are rendered at build time by the public
[Kroki](https://kroki.io/) service via the `asciidoctor-kroki` extension. So
`npm run docs:build` needs **outbound network access to kroki.io** — but no
local Kroki, PlantUML or Java install (and no Docker, per the section 2
guardrails). The build fetches each SVG into `build/site/` (`kroki-fetch-diagram`),
so published pages serve site-local images and never hotlink kroki.io. Edit a
diagram by editing its source in the page; never commit rendered SVGs. Note that
Antora resolves `url: .` through git, so it builds the **committed** state of
your branch — commit diagram edits before building, and build from a normal
clone (Antora cannot read a `git worktree` checkout).

### Pi edge operations

The dedicated `docker-compose.pi-edge.yml` is not a general self-hosting
sample. It records the explicit, single-Pi `edge` opt-in governed by issue #286
and ADR-70. The complete backup, registry/platform verification, activation,
rollback, and post-merge acceptance runbook is deployment view 7.5.1. Editing
or merging these repository files does **not** authorize a Pi mutation.

That lifecycle is `MERGE_PENDING_PRODUCTION_ACCEPTANCE`: the docs/config PR
must not close #286, cannot merge until the documented pre-merge Pi gates pass,
and does not prove unattended replacement. After merge, the issue stays open
until the secret-free production evidence packet receives the human's exact
`ACCEPT <packet-sha256>` statement. Never put a password, token, Docker auth
content, rendered secret configuration, or sensitive backup path in a commit,
PR, issue, log, or evidence packet.

## Releasing

Releases are tag-driven (#192, ADR-53). Pushing a semver tag `v<x.y.z>` (final)
or `v<x.y.z>-rc.N` / `-beta.N` (pre-release) to `main` runs the
[`Release`](.github/workflows/release.yml) workflow, which:

1. Runs the **full** test suite (type checks + unit/integration + Playwright
   E2E — the same coverage as `ci.yml`). Any failure aborts the release before
   anything is published.
2. Builds the multi-arch container image (`linux/amd64` + `linux/arm64`, #191)
   and pushes it to `ghcr.io/felixgeisler/draw`, tagged with the version. A
   **final** release also updates `:latest`; pre-releases do not.
3. Creates a GitHub Release for the tag with generated notes. `-rc`/`-beta`
   tags (any tag with a `-`) are marked as pre-releases.

**One-time after the first-ever release:** GHCR creates the package *private*,
and the workflow's `GITHUB_TOKEN` cannot change that. Flip it to **Public** once
in the package's GitHub page → *Package settings → Change visibility* (or tell
users to `docker login ghcr.io` with a `read:packages` token), or the
`docker pull` above fails with `denied`/`not found`.

```
git tag v1.0.0 && git push origin v1.0.0     # final → :1.0.0 and :latest
git tag v1.1.0-rc.1 && git push origin v1.1.0-rc.1   # pre-release → :1.1.0-rc.1 only
```

The version numbers in the three `package.json` files are **not** part of this
workflow — bump them in a normal PR before tagging.

**Dry run (build verification without a tag):** trigger the workflow manually
(`gh workflow run release.yml --ref <branch>`, or the *Run workflow* button).
It runs the gate and pushes the image to a throwaway `:dryrun` tag — never
`:latest`, no version tag, and no Release — so you can confirm the multi-arch
build actually works before spending a real `v*` tag. `workflow_dispatch` is
only available once the workflow file is on the default branch.
