import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Immutable commit publication contract (#277, ADR-53). Actions cannot be run
// safely from the unit suite, so these tests pin the committed workflow shape
// and exercise its first-write-wins state model without Docker, credentials, a
// registry, package mutation, or GitHub Actions execution.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const edge = fs.readFileSync(path.join(repoRoot, ".github/workflows/edge.yml"), "utf8");

const job = edge.slice(edge.indexOf("\n  publication:"));
const beforeSteps = job.slice(0, job.indexOf("\n    steps:"));
const actionReferences = edge.match(/uses:\s*[^\s]+/g) ?? [];

function step(name: string): string {
  const start = edge.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`missing workflow step: ${name}`);
  const next = edge.indexOf("\n      - name:", start + 1);
  return edge.slice(start, next < 0 ? edge.length : next);
}

type WorkflowRun = {
  conclusion: string;
  event: string;
  headBranch: string;
  headRepository: string;
  repository: string;
  path: string;
};

const authorized = (run: WorkflowRun) =>
  run.conclusion === "success" &&
  run.event === "push" &&
  run.headBranch === "main" &&
  run.headRepository === run.repository &&
  run.path === ".github/workflows/ci.yml";

const validRun: WorkflowRun = {
  conclusion: "success",
  event: "push",
  headBranch: "main",
  headRepository: "FelixGeisler/draw",
  repository: "FelixGeisler/draw",
  path: ".github/workflows/ci.yml",
};

describe("edge workflow authorization and isolation", () => {
  it("routes completed CI workflow runs but authorizes with all five predicates", () => {
    expect(edge).toMatch(/workflow_run:\s*[\s\S]*?workflows:\s*\["CI"\][\s\S]*?types:\s*\[completed\]/);
    expect(beforeSteps).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(beforeSteps).toContain("github.event.workflow_run.event == 'push'");
    expect(beforeSteps).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(beforeSteps).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(beforeSteps).toContain(
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
    );
    expect(authorized(validRun)).toBe(true);
  });

  it.each([
    ["failed CI", { conclusion: "failure" }],
    ["pull request CI", { event: "pull_request" }],
    ["feature branch", { headBranch: "feature" }],
    ["fork", { headRepository: "attacker/draw" }],
    ["same-name workflow elsewhere", { path: ".github/workflows/not-ci.yml" }],
  ])("rejects %s before package-writing steps", (_name, patch) => {
    expect(authorized({ ...validRun, ...patch })).toBe(false);
  });

  it("treats every non-exact path as unauthorized, not the CI display name as authority", () => {
    for (const otherPath of [
      "ci.yml",
      ".github/workflows/CI.yml",
      ".github/workflows/ci.yaml",
      ".github/workflows/nested/ci.yml",
      ".github/workflows/release.yml",
      "",
    ]) {
      expect(authorized({ ...validRun, path: otherPath })).toBe(false);
    }
  });

  it("is detached from pull-request checks and checks out only the event head SHA", () => {
    const trigger = edge.slice(edge.indexOf("\non:"), edge.indexOf("\npermissions:"));
    expect(trigger).not.toMatch(/^\s*pull_request:/m);
    expect(trigger).not.toMatch(/^\s*push:/m);
    const checkout = step("Check out the tested commit");
    expect(checkout).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(checkout).not.toContain("github.sha");
    expect(checkout).not.toContain("github.ref");
  });
});

describe("edge workflow privilege, concurrency, and action supply chain", () => {
  it("uses read-only workflow permissions and the exact publication-job permissions", () => {
    const workflowScope = edge.slice(0, edge.indexOf("\njobs:"));
    expect(workflowScope.match(/permissions:\s*\n\s+contents:\s*read/g)).toHaveLength(1);
    expect(workflowScope).not.toMatch(/^\s*(contents|packages):\s*write/m);
    expect(beforeSteps).toMatch(
      /permissions:\s*\n\s+contents:\s*read\s*\n\s+packages:\s*write\s*\n/,
    );
    expect(beforeSteps.match(/^[ \t]+[a-z-]+:[ \t]*(read|write)[ \t]*$/gm)).toEqual([
      "      contents: read",
      "      packages: write",
    ]);
    expect(beforeSteps).toContain("timeout-minutes: 60");
    expect(beforeSteps).not.toContain("env:");
  });

  it("serializes only the same SHA without cancellation", () => {
    const workflowScope = edge.slice(0, edge.indexOf("\njobs:"));
    expect(workflowScope).toContain(
      "group: edge-publication-${{ github.event.workflow_run.head_sha }}",
    );
    expect(workflowScope).toContain("cancel-in-progress: false");
  });

  it("sets up Node 22 after checkout and before both inspector calls", () => {
    const checkoutAt = edge.indexOf("- name: Check out the tested commit");
    const nodeAt = edge.indexOf("- name: Set up Node for the repository inspector");
    const firstInspectorAt = edge.indexOf("node scripts/inspect-oci-image.mjs");
    expect(checkoutAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(checkoutAt);
    expect(firstInspectorAt).toBeGreaterThan(nodeAt);
    expect(step("Set up Node for the repository inspector")).toContain("node-version: 22");
    expect(edge).not.toMatch(/npm (ci|install)/);
  });

  it("uses exactly the seven approved full-SHA action invocations", () => {
    expect(actionReferences).toEqual([
      "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
      "uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051",
      "uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
    ]);
    for (const reference of actionReferences) expect(reference).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("edge workflow inspector controller and credential boundary", () => {
  const initial = step("Inspect before any package mutation");
  const postPush = step("Verify the pushed digest");
  const login = step("Log in to GHCR");
  const build = step("Build and push the absent commit tag");

  it("invokes only the merged CLI in expected-revision mode, once before and once after push", () => {
    const invocations = edge.match(
      /node scripts\/inspect-oci-image\.mjs --image "\$TARGET" --expected-revision "\$SHA"/g,
    );
    expect(invocations).toHaveLength(2);
    expect(initial).toContain('case "$status" in');
    expect(initial).toMatch(/0\)[\s\S]*build=false/);
    expect(initial).toMatch(/3\)[\s\S]*build=true/);
    expect(initial).toMatch(/\*\)[\s\S]*exit 1/);
    expect(initial).toContain('keys.join(",") !== "digest,revision"');
    expect(initial).toContain("existing-digest=$digest");
  });

  it("binds inspector credentials only on the two inspector steps", () => {
    expect(edge.match(/OCI_REGISTRY_USERNAME:/g)).toHaveLength(2);
    expect(edge.match(/OCI_REGISTRY_PASSWORD:/g)).toHaveLength(2);
    for (const inspector of [initial, postPush]) {
      expect(inspector).toContain("OCI_REGISTRY_USERNAME: ${{ github.actor }}");
      expect(inspector).toContain("OCI_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}");
      expect(inspector).not.toMatch(/echo[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/);
      expect(inspector).not.toMatch(/inspect-oci-image[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/);
    }
    const withoutInspectors = edge.replace(initial, "").replace(postPush, "");
    expect(withoutInspectors).not.toContain("OCI_REGISTRY_");
  });

  it("gives the pinned login action exactly its three inputs and no direct build credentials", () => {
    expect(login).toMatch(
      /with:\s*\n\s+registry: ghcr\.io\s*\n\s+username: \$\{\{ github\.actor \}\}\s*\n\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/,
    );
    expect(build).not.toContain("GITHUB_TOKEN");
    expect(build).not.toContain("github.actor");
    expect(build).not.toContain("OCI_REGISTRY_");
    expect(build).not.toContain("password:");
    expect(build).not.toContain("username:");
  });

  it("requires valid post-push JSON and exact equality with the build action digest", () => {
    expect(build).toContain("id: build");
    expect(postPush).toContain("EXPECTED_DIGEST: ${{ steps.build.outputs.digest }}");
    expect(postPush).toContain('if [[ "$status" -ne 0 ]]');
    expect(postPush).toContain('keys.join(",") !== "digest,revision"');
    expect(postPush).toContain('[[ "$digest" != "$EXPECTED_DIGEST" ]]');
    expect(postPush).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
  });
});

describe("edge workflow absent build contract", () => {
  const target = step("Derive the one permitted target");
  const metadata = step("Derive immutable image metadata");
  const build = step("Build and push the absent commit tag");

  it("derives only one lowercase full-SHA tag", () => {
    expect(target).toContain('[[ "$EVENT_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(target).toContain("image=ghcr.io/felixgeisler/draw:sha-$EVENT_HEAD_SHA");
    expect(metadata).toContain("flavor: latest=false");
    expect(metadata).toContain("tags: type=raw,value=sha-${{ steps.target.outputs.sha }}");
    expect(metadata.match(/^\s+tags:/gm)).toHaveLength(1);
  });

  it("builds exactly two platforms with the approved identity and no provenance", () => {
    expect(build).toContain("platforms: linux/amd64,linux/arm64");
    expect(build).toContain("provenance: false");
    expect(build).toMatch(
      /build-args:\s*\|\s*\n\s+DRAW_BUILD_CHANNEL=edge\s*\n\s+DRAW_BUILD_SHA=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
    expect(build.match(/DRAW_BUILD_/g)).toHaveLength(2);
    expect(build).toMatch(
      /labels: \|\r?\n\s+org\.opencontainers\.image\.revision=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
    expect(build).toMatch(
      /annotations: \|\r?\n\s+index:org\.opencontainers\.image\.revision=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
  });

  it("contains no mutable/release tag producer or destructive package command", () => {
    const executable = edge
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/type=(semver|sha)/);
    expect(executable).not.toMatch(/value=(edge|latest|dryrun)/);
    expect(executable).not.toMatch(/gh release|docker manifest (rm|push)|docker buildx imagetools create/);
    expect(executable).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
    expect(build).toContain("push: true");
    expect(build).toContain("tags: ${{ steps.meta.outputs.tags }}");
  });
});

type Existing = { kind: "valid"; digest: string } | { kind: "invalid" };
type PostPush = "valid" | "mismatch" | "absent" | "failure";
type Mutation = { kind: "external-write" | "push"; sha: string; digest: string };
type ModelResult = {
  state: "reused" | "published" | "wedged";
  digest?: string;
  residualRace: boolean;
};

class PublicationModel {
  readonly registry = new Map<string, Existing>();
  readonly mutations: Mutation[] = [];
  inspectorFailure = new Set<string>();

  run({
    sha,
    buildDigest,
    postPush = "valid",
    externalDigest,
  }: {
    sha: string;
    buildDigest: string;
    postPush?: PostPush;
    externalDigest?: string;
  }): ModelResult {
    if (this.inspectorFailure.has(sha)) return { state: "wedged", residualRace: false };
    const observed = this.registry.get(sha);
    if (observed?.kind === "valid") {
      return { state: "reused", digest: observed.digest, residualRace: false };
    }
    if (observed?.kind === "invalid") return { state: "wedged", residualRace: false };

    let residualRace = false;
    if (externalDigest !== undefined) {
      residualRace = true;
      this.registry.set(sha, { kind: "valid", digest: externalDigest });
      this.mutations.push({ kind: "external-write", sha, digest: externalDigest });
    }

    // Only the authoritative-absence path reaches this one automation push.
    this.registry.set(sha, { kind: "valid", digest: buildDigest });
    this.mutations.push({ kind: "push", sha, digest: buildDigest });
    if (postPush !== "valid") {
      if (postPush === "absent") this.registry.delete(sha);
      return { state: "wedged", residualRace };
    }
    return { state: "published", digest: buildDigest, residualRace };
  }
}

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe("immutable commit publication state model", () => {
  it("preserves at least three distinct commits that complete in reverse order", () => {
    const model = new PublicationModel();
    for (const character of ["c", "b", "a"]) {
      expect(model.run({ sha: sha(character), buildDigest: digest(character) }).state).toBe(
        "published",
      );
    }
    expect([...model.registry.keys()]).toEqual([sha("c"), sha("b"), sha("a")]);
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(3);
  });

  it("reuses observed valid presence on same-SHA reruns without replacement push", () => {
    const model = new PublicationModel();
    model.run({ sha: sha("a"), buildDigest: digest("1") });
    const rerun = model.run({ sha: sha("a"), buildDigest: digest("2") });
    expect(rerun).toEqual({ state: "reused", digest: digest("1"), residualRace: false });
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(1);
    expect(model.registry.get(sha("a"))).toEqual({ kind: "valid", digest: digest("1") });
  });

  it("allows only authoritative absence to build and wedges inspection/invalid-content failures", () => {
    const model = new PublicationModel();
    model.inspectorFailure.add(sha("a"));
    model.registry.set(sha("b"), { kind: "invalid" });
    expect(model.run({ sha: sha("a"), buildDigest: digest("1") }).state).toBe("wedged");
    expect(model.run({ sha: sha("b"), buildDigest: digest("2") }).state).toBe("wedged");
    expect(model.run({ sha: sha("c"), buildDigest: digest("3") }).state).toBe("published");
    expect(model.mutations).toEqual([{ kind: "push", sha: sha("c"), digest: digest("3") }]);
  });

  it.each(["mismatch", "absent", "failure"] as const)(
    "wedges post-push %s without an automated repair mutation",
    (postPush) => {
      const model = new PublicationModel();
      expect(model.run({ sha: sha("a"), buildDigest: digest("1"), postPush }).state).toBe(
        "wedged",
      );
      expect(model.mutations).toEqual([{ kind: "push", sha: sha("a"), digest: digest("1") }]);
    },
  );

  it("represents the accepted non-atomic external race and possible overwrite", () => {
    const model = new PublicationModel();
    const result = model.run({
      sha: sha("a"),
      buildDigest: digest("1"),
      externalDigest: digest("e"),
    });
    expect(result).toEqual({ state: "published", digest: digest("1"), residualRace: true });
    expect(model.mutations).toEqual([
      { kind: "external-write", sha: sha("a"), digest: digest("e") },
      { kind: "push", sha: sha("a"), digest: digest("1") },
    ]);
    expect(model.registry.get(sha("a"))).toEqual({ kind: "valid", digest: digest("1") });
  });
});
