import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Release pipeline contract (#192, ADR-53). GitHub Actions workflows are not
// runnable in CI here, so — like the container contract — this pins the SHAPE
// of the release workflow to what the release actually depends on: a v*-tag
// trigger, the full test gate before publish, a multi-arch push to the real
// GHCR path, and a Release step. A rename/miswire fails here, not on a live
// tag push where it would half-publish. No Docker/Actions required: reads the
// committed YAML as text (same approach as container-contract.test.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf-8");

const release = read(".github/workflows/release.yml");
const ci = read(".github/workflows/ci.yml");
const compose = read("docker-compose.yml");

// The GHCR path the whole 1.0.0 deployment story hangs on. Kept as one
// constant so the workflow, the compose image line, and the docs cannot drift.
const IMAGE = "ghcr.io/felixgeisler/draw";

describe("release workflow trigger", () => {
  it("fires on v* tags", () => {
    // A `tags: [ "v*" ]` push trigger — matches v1.0.0 and v1.0.0-rc.1.
    expect(release).toMatch(/on:\s*[\s\S]*?push:\s*[\s\S]*?tags:\s*[\s\S]*?-\s*"v\*"/);
  });

  it("does NOT run on branch pushes or pull requests", () => {
    // Publishing must never be triggered by ordinary development. The push
    // trigger carries `tags:` and no `branches:`, and there is no pull_request.
    expect(release).not.toMatch(/^\s*pull_request:/m);
    expect(release).not.toMatch(/branches:/);
  });

  it("offers a workflow_dispatch dry run for pre-tag verification", () => {
    expect(release).toMatch(/workflow_dispatch:/);
  });
});

describe("release workflow gate", () => {
  it("runs the same test coverage as ci.yml before publishing", () => {
    // Type checks + unit/integration + Playwright E2E, verbatim from ci.yml.
    expect(release).toContain("npm run build -w server && npx tsc --noEmit -p client/tsconfig.json");
    expect(release).toMatch(/run:\s*npm test/);
    expect(release).toContain("npm run test:e2e");
  });

  it("makes the publish job depend on the test job (no green tests, no image)", () => {
    expect(release).toMatch(/publish:\s*[\s\S]*?needs:\s*test/);
  });
});

describe("release workflow publish", () => {
  it("keeps the token least-privilege: read at workflow scope, write only on publish", () => {
    // Split at `jobs:` — the write scopes must live on the publish job, never
    // at workflow scope where the `npm ci`/Playwright test gate would inherit
    // them (a compromised dependency could push a backdoored :latest).
    const jobsAt = release.indexOf("\njobs:");
    const workflowScope = release.slice(0, jobsAt);
    const jobsScope = release.slice(jobsAt);
    expect(workflowScope).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    // No write scope as a real YAML key at workflow level (comment prose that
    // mentions "write" starts with `#` and is not a `key: write` line).
    expect(workflowScope).not.toMatch(/^\s*(contents|packages):\s*write/m);
    // The publish job (and only it) escalates to exactly the two write scopes.
    const publishJob = jobsScope.slice(jobsScope.indexOf("\n  publish:"));
    expect(publishJob).toMatch(/permissions:\s*[\s\S]*?contents:\s*write/);
    expect(publishJob).toMatch(/permissions:\s*[\s\S]*?packages:\s*write/);
    // The test gate declares no permissions of its own → inherits read-only.
    const testJob = jobsScope.slice(jobsScope.indexOf("\n  test:"), jobsScope.indexOf("\n  publish:"));
    expect(testJob).not.toContain("permissions:");
  });

  it("logs in to GHCR with the built-in GITHUB_TOKEN (no PAT)", () => {
    expect(release).toContain("registry: ghcr.io");
    expect(release).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("builds both target architectures", () => {
    // linux/arm64 (Raspberry Pi) + linux/amd64 (desktop/server) — the whole
    // reason for QEMU + buildx.
    expect(release).toContain("linux/amd64,linux/arm64");
    expect(release).toContain("docker/setup-qemu-action");
    expect(release).toContain("docker/setup-buildx-action");
  });

  it("pins every third-party docker/* action to a full commit SHA", () => {
    // This is the credential-bearing job; a moved tag must not be able to slip
    // new code next to the packages:write token. Each pin carries a `# vN`
    // comment so the human version is still legible.
    const pins = release.match(/uses:\s*docker\/[^\n]+/g) ?? [];
    expect(pins).toHaveLength(5);
    for (const pin of pins) {
      expect(pin).toMatch(/@[0-9a-f]{40} # v\d+/);
    }
  });

  it("keeps every existing action reference unchanged", () => {
    expect(release.match(/uses:\s*[^\s]+/g)).toEqual([
      "uses: actions/checkout@v4",
      "uses: actions/setup-node@v4",
      "uses: actions/upload-artifact@v4",
      "uses: actions/checkout@v4",
      "uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
      "uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051",
      "uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
    ]);
  });

  it("pushes to the real GHCR image path without provenance manifests", () => {
    expect(release).toContain(`images: ${IMAGE}`);
    expect(release).toMatch(/push:\s*true/);
    expect(release).toMatch(/provenance:\s*false/);
  });

  it("uses the publish checkout commit as build identity for tags and dispatch refs", () => {
    const publishJob = release.slice(release.indexOf("\n  publish:"));
    expect(publishJob).toContain("ref: ${{ github.event.inputs.ref || github.ref }}");
    expect(publishJob).toMatch(/id:\s*build[\s\S]*?git rev-parse HEAD/);
    expect(publishJob).toContain(
      "DRAW_BUILD_CHANNEL=${{ github.event_name == 'push' && 'stable' || 'local' }}",
    );
    expect(publishJob).toContain("DRAW_BUILD_SHA=${{ steps.build.outputs.sha }}");
    expect(publishJob).not.toContain("DRAW_BUILD_SHA=${{ github.sha }}");
    expect(publishJob).not.toContain("DRAW_BUILD_SHA=${{ github.event.inputs.ref }}");
  });

  it("tags semver/conditional-latest on pushes and only dryrun on dispatch", () => {
    // The version tag is push-gated on the EVENT, not the ref: a dispatch dry
    // run (even one launched from a tag ref) must never emit a real :version.
    expect(release).toMatch(
      /type=semver,pattern=\{\{version\}\},enable=\$\{\{ github\.event_name == 'push' \}\}/,
    );
    // `latest` is gated on a non-prerelease push (no `-` in the tag name).
    expect(release).toMatch(/type=raw,value=latest,enable=.*!contains\(github\.ref_name, '-'\)/);
    expect(release).toContain(
      "type=raw,value=dryrun,enable=${{ github.event_name == 'workflow_dispatch' }}",
    );
  });

  it("creates a GitHub Release on tag pushes, flagging pre-releases", () => {
    expect(release).toContain("gh release create");
    expect(release).toContain("--generate-notes");
    expect(release).toContain("--prerelease");
    // The Release step is skipped on the dry-run dispatch.
    expect(release).toMatch(/if:\s*github\.event_name == 'push'/);
  });
});

describe("release workflow does not disturb the other pipelines", () => {
  it("leaves ci.yml triggering on PRs and main, never on tags", () => {
    expect(ci).toMatch(/on:\s*[\s\S]*?pull_request:/);
    expect(ci).toMatch(/branches:\s*\[main\]/);
    expect(ci).not.toContain("tags:");
  });

  it("agrees with the compose file on the published image path", () => {
    // The commented pull-me line in docker-compose.yml must name the same
    // image the workflow pushes, or a self-hoster pulls a nonexistent tag.
    expect(compose).toContain(`image: ${IMAGE}:latest`);
  });
});
