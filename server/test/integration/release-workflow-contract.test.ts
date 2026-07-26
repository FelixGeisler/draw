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
  it("grants exactly the permissions the built-in token needs", () => {
    // packages:write to push to GHCR, contents:write to create the Release.
    expect(release).toMatch(/permissions:\s*[\s\S]*?contents:\s*write/);
    expect(release).toMatch(/permissions:\s*[\s\S]*?packages:\s*write/);
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

  it("pushes to the real GHCR image path", () => {
    expect(release).toContain(`images: ${IMAGE}`);
    expect(release).toMatch(/push:\s*true/);
  });

  it("tags the semver AND latest, but keeps latest off pre-releases", () => {
    expect(release).toContain("type=semver,pattern={{version}}");
    // `latest` is gated on a non-prerelease push (no `-` in the tag name).
    expect(release).toMatch(/type=raw,value=latest,enable=.*!contains\(github\.ref_name, '-'\)/);
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
