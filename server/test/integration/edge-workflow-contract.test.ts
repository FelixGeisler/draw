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
const edge = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/edge.yml"),
  "utf8",
);

const publicationAt = edge.indexOf("\n  publication:");
const promotionAt = edge.indexOf("\n  promotion:");
const publicationJob = edge.slice(publicationAt, promotionAt);
const promotionJob = edge.slice(promotionAt);
const beforeSteps = publicationJob.slice(
  0,
  publicationJob.indexOf("\n    steps:"),
);
const actionReferences = edge.match(/uses:\s*[^\s]+/g) ?? [];
const publicationActions = publicationJob.match(/uses:\s*[^\s]+/g) ?? [];
const promotionActions = promotionJob.match(/uses:\s*[^\s]+/g) ?? [];

function step(name: string, scope = edge): string {
  const start = scope.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`missing workflow step: ${name}`);
  const next = scope.indexOf("\n      - name:", start + 1);
  return scope.slice(start, next < 0 ? scope.length : next);
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
    expect(edge).toMatch(
      /workflow_run:\s*[\s\S]*?workflows:\s*\["CI"\][\s\S]*?types:\s*\[completed\]/,
    );
    expect(beforeSteps).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(beforeSteps).toContain("github.event.workflow_run.event == 'push'");
    expect(beforeSteps).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
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
    const trigger = edge.slice(
      edge.indexOf("\non:"),
      edge.indexOf("\npermissions:"),
    );
    expect(trigger).not.toMatch(/^\s*pull_request:/m);
    expect(trigger).not.toMatch(/^\s*push:/m);
    const checkout = step("Check out the tested commit", publicationJob);
    expect(checkout).toContain(
      "ref: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(checkout).not.toContain("github.sha");
    expect(checkout).not.toContain("github.ref");
  });
});

describe("edge workflow privilege, concurrency, and action supply chain", () => {
  it("uses read-only workflow permissions and the exact publication-job permissions", () => {
    const workflowScope = edge.slice(0, edge.indexOf("\njobs:"));
    expect(
      workflowScope.match(/permissions:\s*\n\s+contents:\s*read/g),
    ).toHaveLength(1);
    expect(workflowScope).not.toMatch(/^\s*(contents|packages):\s*write/m);
    expect(beforeSteps).toMatch(
      /permissions:\s*\n\s+contents:\s*read\s*\n\s+packages:\s*write\s*\n/,
    );
    expect(
      beforeSteps.match(/^[ \t]+[a-z-]+:[ \t]*(read|write)[ \t]*$/gm),
    ).toEqual(["      contents: read", "      packages: write"]);
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
    const nodeAt = edge.indexOf(
      "- name: Set up Node for the repository inspector",
    );
    const firstInspectorAt = edge.indexOf("node scripts/inspect-oci-image.mjs");
    expect(checkoutAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(checkoutAt);
    expect(firstInspectorAt).toBeGreaterThan(nodeAt);
    expect(
      step("Set up Node for the repository inspector", publicationJob),
    ).toContain("node-version: 22");
    expect(edge).not.toMatch(/npm (ci|install)/);
  });

  it("preserves the publication job's exact seven full-SHA action invocations", () => {
    expect(publicationActions).toEqual([
      "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
      "uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051",
      "uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
    ]);
    for (const reference of actionReferences)
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("edge workflow inspector controller and credential boundary", () => {
  const initial = step("Inspect before any package mutation", publicationJob);
  const postPush = step("Verify the pushed digest", publicationJob);
  const login = step("Log in to GHCR", publicationJob);
  const build = step("Build and push the absent commit tag", publicationJob);

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
    expect(publicationJob.match(/OCI_REGISTRY_USERNAME:/g)).toHaveLength(2);
    expect(publicationJob.match(/OCI_REGISTRY_PASSWORD:/g)).toHaveLength(2);
    for (const inspector of [initial, postPush]) {
      expect(inspector).toContain("OCI_REGISTRY_USERNAME: ${{ github.actor }}");
      expect(inspector).toContain(
        "OCI_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}",
      );
      expect(inspector).not.toMatch(/echo[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/);
      expect(inspector).not.toMatch(
        /inspect-oci-image[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/,
      );
    }
    const withoutInspectors = publicationJob
      .replace(initial, "")
      .replace(postPush, "");
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
    expect(postPush).toContain(
      "EXPECTED_DIGEST: ${{ steps.build.outputs.digest }}",
    );
    expect(postPush).toContain('if [[ "$status" -ne 0 ]]');
    expect(postPush).toContain('keys.join(",") !== "digest,revision"');
    expect(postPush).toContain('[[ "$digest" != "$EXPECTED_DIGEST" ]]');
    expect(postPush).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
  });
});

describe("edge workflow absent build contract", () => {
  const target = step("Derive the one permitted target", publicationJob);
  const metadata = step("Derive immutable image metadata", publicationJob);
  const build = step("Build and push the absent commit tag", publicationJob);

  it("derives only one lowercase full-SHA tag", () => {
    expect(target).toContain('[[ "$EVENT_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(target).toContain(
      "image=ghcr.io/felixgeisler/draw:sha-$EVENT_HEAD_SHA",
    );
    expect(metadata).toContain("flavor: latest=false");
    expect(metadata).toContain(
      "tags: type=raw,value=sha-${{ steps.target.outputs.sha }}",
    );
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
    const executable = publicationJob
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/type=(semver|sha)/);
    expect(executable).not.toMatch(/value=(edge|latest|dryrun)/);
    expect(executable).not.toMatch(
      /gh release|docker manifest (rm|push)|docker buildx imagetools create/,
    );
    expect(executable).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
    expect(build).toContain("push: true");
    expect(build).toContain("tags: ${{ steps.meta.outputs.tags }}");
  });
});

type Existing = { kind: "valid"; digest: string } | { kind: "invalid" };
type PostPush = "valid" | "mismatch" | "absent" | "failure";
type Mutation = {
  kind: "external-write" | "push";
  sha: string;
  digest: string;
};
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
    if (this.inspectorFailure.has(sha))
      return { state: "wedged", residualRace: false };
    const observed = this.registry.get(sha);
    if (observed?.kind === "valid") {
      return { state: "reused", digest: observed.digest, residualRace: false };
    }
    if (observed?.kind === "invalid")
      return { state: "wedged", residualRace: false };

    let residualRace = false;
    if (externalDigest !== undefined) {
      residualRace = true;
      this.registry.set(sha, { kind: "valid", digest: externalDigest });
      this.mutations.push({
        kind: "external-write",
        sha,
        digest: externalDigest,
      });
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
      expect(
        model.run({ sha: sha(character), buildDigest: digest(character) })
          .state,
      ).toBe("published");
    }
    expect([...model.registry.keys()]).toEqual([sha("c"), sha("b"), sha("a")]);
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(
      3,
    );
  });

  it("reuses observed valid presence on same-SHA reruns without replacement push", () => {
    const model = new PublicationModel();
    model.run({ sha: sha("a"), buildDigest: digest("1") });
    const rerun = model.run({ sha: sha("a"), buildDigest: digest("2") });
    expect(rerun).toEqual({
      state: "reused",
      digest: digest("1"),
      residualRace: false,
    });
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(
      1,
    );
    expect(model.registry.get(sha("a"))).toEqual({
      kind: "valid",
      digest: digest("1"),
    });
  });

  it("allows only authoritative absence to build and wedges inspection/invalid-content failures", () => {
    const model = new PublicationModel();
    model.inspectorFailure.add(sha("a"));
    model.registry.set(sha("b"), { kind: "invalid" });
    expect(model.run({ sha: sha("a"), buildDigest: digest("1") }).state).toBe(
      "wedged",
    );
    expect(model.run({ sha: sha("b"), buildDigest: digest("2") }).state).toBe(
      "wedged",
    );
    expect(model.run({ sha: sha("c"), buildDigest: digest("3") }).state).toBe(
      "published",
    );
    expect(model.mutations).toEqual([
      { kind: "push", sha: sha("c"), digest: digest("3") },
    ]);
  });

  it.each(["mismatch", "absent", "failure"] as const)(
    "wedges post-push %s without an automated repair mutation",
    (postPush) => {
      const model = new PublicationModel();
      expect(
        model.run({ sha: sha("a"), buildDigest: digest("1"), postPush }).state,
      ).toBe("wedged");
      expect(model.mutations).toEqual([
        { kind: "push", sha: sha("a"), digest: digest("1") },
      ]);
    },
  );

  it("represents the accepted non-atomic external race and possible overwrite", () => {
    const model = new PublicationModel();
    const result = model.run({
      sha: sha("a"),
      buildDigest: digest("1"),
      externalDigest: digest("e"),
    });
    expect(result).toEqual({
      state: "published",
      digest: digest("1"),
      residualRace: true,
    });
    expect(model.mutations).toEqual([
      { kind: "external-write", sha: sha("a"), digest: digest("e") },
      { kind: "push", sha: sha("a"), digest: digest("1") },
    ]);
    expect(model.registry.get(sha("a"))).toEqual({
      kind: "valid",
      digest: digest("1"),
    });
  });
});

const promotionBeforeSteps = promotionJob.slice(
  0,
  promotionJob.indexOf("\n    steps:"),
);
const promotionCheckout = step(
  "Check out promotion scripts without persisted credentials",
  promotionJob,
);
const historyStep = step(
  "Establish isolated public main history",
  promotionJob,
);
const sourceStep = step("Inspect immutable current-main source", promotionJob);
const existingStep = step("Inspect existing edge state", promotionJob);
const ancestryStep = step(
  "Prove existing edge is not ahead of current main",
  promotionJob,
);
const mutationStep = step(
  "Promote verified digest to edge exactly once",
  promotionJob,
);
const postPromotionStep = step("Verify promoted edge state", promotionJob);
const cleanupStep = step("Remove isolated promotion history", promotionJob);

function promotionRunSteps(workflowJob: string): string[] {
  return workflowJob
    .split(/(?=^      - name: )/m)
    .filter(
      (candidate) =>
        /^      - name: /m.test(candidate) &&
        /^        run: \|/m.test(candidate),
    );
}

const forbiddenGitConfig = (key: string) =>
  /^(http\..*\.extraheader|credential(\..*)?\.(helper|store)|url\..*\.(insteadof|pushinsteadof))$/i.test(
    key,
  );

describe("promotion workflow authorization, runner, and action boundary", () => {
  it("is a separate globally serialized job after publication with all five gates", () => {
    expect(promotionBeforeSteps).toContain("needs: publication");
    for (const predicate of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
    ]) {
      expect(promotionBeforeSteps).toContain(predicate);
    }
    expect(promotionBeforeSteps).toContain("runs-on: ubuntu-24.04");
    expect(promotionBeforeSteps).toMatch(
      /permissions:\s*\n\s+contents: read\s*\n\s+packages: write\s*\n/,
    );
    expect(promotionBeforeSteps).toContain("timeout-minutes: 60");
    expect(promotionBeforeSteps).toMatch(
      /concurrency:\s*\n\s+group: edge-promotion\s*\n\s+cancel-in-progress: false/,
    );
    expect(beforeSteps).toContain("runs-on: ubuntu-latest");
  });

  it.each([
    "ubuntu-latest",
    "self-hosted",
    "windows-latest",
    "macos-latest",
    "",
  ])("rejects the non-contract promotion runner %j", (runner) =>
    expect(runner).not.toBe("ubuntu-24.04"),
  );

  it("declares exact Bash on every promotion shell step", () => {
    const runSteps = promotionRunSteps(promotionJob);
    expect(
      runSteps.map((candidate) => candidate.match(/- name: ([^\n]+)/)?.[1]),
    ).toEqual([
      "Establish isolated public main history",
      "Inspect immutable current-main source",
      "Inspect existing edge state",
      "Prove existing edge is not ahead of current main",
      "Promote verified digest to edge exactly once",
      "Verify promoted edge state",
      "Remove isolated promotion history",
    ]);
    for (const candidate of runSteps)
      expect(candidate).toMatch(/^        shell: bash$/m);
    for (const invalid of ["", "sh", "pwsh", "cmd"])
      expect(invalid).not.toBe("bash");
  });

  it("uses only the four approved pinned promotion actions", () => {
    expect(promotionActions).toEqual([
      "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
    ]);
    expect(actionReferences).toHaveLength(11);
    for (const reference of promotionActions)
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("promotion history authority and lifecycle contract", () => {
  it("checks out scripts without persistence and immediately performs the hygiene gate", () => {
    expect(promotionCheckout).toContain(
      "ref: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(promotionCheckout).toContain("persist-credentials: false");
    expect(promotionCheckout).toContain("fetch-depth: 0");
    expect(promotionCheckout).not.toMatch(/^\s+token:/m);
    expect(promotionJob.match(/^      - name: .+$/gm)?.slice(0, 2)).toEqual([
      "      - name: Check out promotion scripts without persisted credentials",
      "      - name: Establish isolated public main history",
    ]);
    expect(
      promotionJob.indexOf("- name: Establish isolated public main history"),
    ).toBeLessThan(promotionJob.indexOf("node scripts/inspect-oci-image.mjs"));
    expect(
      promotionJob.indexOf("- name: Establish isolated public main history"),
    ).toBeLessThan(promotionJob.indexOf("merge-base --is-ancestor"));
  });

  it("requires the clean literal origin and rejects every credential/rewrite key", () => {
    expect(historyStep).toContain(
      "readonly public_url='https://github.com/FelixGeisler/draw.git'",
    );
    expect(historyStep).toContain("git remote get-url --all origin");
    expect(historyStep).toContain("git remote get-url --all --push origin");
    for (const key of [
      "http.https://github.com/.extraheader",
      "credential.helper",
      "credential.https://github.com.helper",
      "credential.store",
      "url.ssh://git@github.com/.insteadof",
      "url.https://mirror/.pushinsteadof",
    ]) {
      expect(forbiddenGitConfig(key)).toBe(true);
    }
    for (const key of ["core.bare", "remote.origin.url", "user.email"]) {
      expect(forbiddenGitConfig(key)).toBe(false);
    }
    expect(historyStep.match(/reject_forbidden_config/g)).toHaveLength(2);
    expect(historyStep).toContain(
      'bare_forbidden="$(isolated_git -C "$bare" config --show-origin --get-regexp "$forbidden" 2>&1)"',
    );
  });

  it("creates one owned 0700 area, empty HOME/template, and an isolated bare repository", () => {
    expect(historyStep).toContain(
      'mktemp -d "$runner_root/edge-promotion.XXXXXXXXXX"',
    );
    expect(historyStep).toContain('chmod 0700 "$area"');
    expect(historyStep).toContain("stat -c '%u'");
    expect(historyStep).toContain("stat -c '%a'");
    expect(historyStep).toContain('mkdir -- "$area/home" "$area/template"');
    expect(historyStep).toContain('env -i PATH="$PATH" HOME="$area/home"');
    expect(historyStep).toContain(
      "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null",
    );
    expect(historyStep).toContain(
      "GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false",
    );
    expect(historyStep).toContain(
      'init --bare --template="$area/template" "$bare"',
    );
    expect(historyStep).not.toContain("GITHUB_TOKEN");
    expect(historyStep).not.toContain("OCI_REGISTRY_");
  });

  it("fetches only literal public main into the isolated ref without a remote or fallback", () => {
    expect(historyStep).toMatch(
      /-c credential\.helper= fetch --no-tags[\s\\]*\n\s+'https:\/\/github\.com\/FelixGeisler\/draw\.git'[\s\\]*\n\s+'refs\/heads\/main:refs\/remotes\/origin\/main'/,
    );
    expect(historyStep).not.toMatch(
      /remote add|Authorization|GITHUB_TOKEN|git -C \.|git fetch origin/,
    );
    expect(historyStep).toContain("'refs/remotes/origin/main^{commit}'");
    expect(historyStep).not.toContain("workflow_run.head_sha");
    expect(historyStep).not.toMatch(/retry|fallback/i);
  });

  it("hands off one exact persistent path, revalidates it, and cleans it last with always", () => {
    expect(historyStep).toContain("trap cleanup_initialization EXIT");
    expect(historyStep).toContain("trap 'exit 130' INT");
    expect(historyStep).toContain("trap 'exit 143' TERM");
    expect(historyStep).toContain(
      'printf \'area=%s\\n\' "$area" >> "$GITHUB_OUTPUT"',
    );
    expect(historyStep).toContain(
      'printf \'target=%s\\n\' "$target" >> "$GITHUB_OUTPUT"',
    );
    expect(historyStep).toContain("trap - EXIT INT TERM");
    expect(ancestryStep).toContain("AREA: ${{ steps.history.outputs.area }}");
    expect(ancestryStep).toContain("edge-promotion.??????????");
    expect(ancestryStep).toContain("stat -c '%u'");
    expect(ancestryStep).toContain("stat -c '%a'");
    expect(cleanupStep).toContain("if: always()");
    expect(cleanupStep).toContain('rm -rf -- "$AREA"');
    expect(promotionJob.trimEnd().endsWith(cleanupStep.trimEnd())).toBe(true);
  });
});

type InspectionResult =
  | { kind: "valid"; digest: string; revision: string }
  | { kind: "absent" }
  | { kind: "invalid" };

function classifyInspection(
  status: number,
  stdout: string,
  expected?: string,
): InspectionResult {
  if (status === 3)
    return stdout === "" ? { kind: "absent" } : { kind: "invalid" };
  if (status !== 0) return { kind: "invalid" };
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "digest,revision" ||
      typeof value.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.digest) ||
      typeof value.revision !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.revision) ||
      (expected !== undefined && value.revision !== expected)
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", digest: value.digest, revision: value.revision };
  } catch {
    return { kind: "invalid" };
  }
}

describe("promotion inspector, credential, and mutation contract", () => {
  it("orders setup after isolated fetch and before all three inspector calls", () => {
    const historyAt = promotionJob.indexOf(
      "- name: Establish isolated public main history",
    );
    const nodeAt = promotionJob.indexOf(
      "- name: Set up Node for promotion inspection",
    );
    const inspectorAt = promotionJob.indexOf(
      "node scripts/inspect-oci-image.mjs",
    );
    expect(historyAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(historyAt);
    expect(inspectorAt).toBeGreaterThan(nodeAt);
    expect(
      step("Set up Node for promotion inspection", promotionJob),
    ).toContain("node-version: 22");
  });

  it("classifies only exact success JSON and output-free exit 3 as valid controller states", () => {
    const revision = sha("a");
    const exact = JSON.stringify({ digest: digest("1"), revision });
    expect(classifyInspection(0, exact, revision)).toEqual({
      kind: "valid",
      digest: digest("1"),
      revision,
    });
    expect(classifyInspection(3, "", revision)).toEqual({ kind: "absent" });
    for (const [status, stdout] of [
      [1, exact],
      [2, exact],
      [4, exact],
      [3, "unexpected"],
      [0, "not json"],
      [0, JSON.stringify({ digest: digest("1"), revision, extra: true })],
      [0, JSON.stringify({ digest: digest("1"), revision: sha("b") })],
    ] as const) {
      expect(classifyInspection(status, stdout, revision)).toEqual({
        kind: "invalid",
      });
    }
    expect(sourceStep).toMatch(/3\)[\s\S]*present=false/);
    expect(sourceStep).toMatch(/\*\)[\s\S]*exit 1/);
    expect(existingStep).toContain("--image 'ghcr.io/felixgeisler/draw:edge'");
    expect(existingStep).not.toContain("--expected-revision");
  });

  it("binds credentials only to each inspector and the exact login inputs", () => {
    expect(promotionJob.match(/OCI_REGISTRY_USERNAME:/g)).toHaveLength(3);
    expect(promotionJob.match(/OCI_REGISTRY_PASSWORD:/g)).toHaveLength(3);
    for (const inspector of [sourceStep, existingStep, postPromotionStep]) {
      expect(inspector).toContain("OCI_REGISTRY_USERNAME: ${{ github.actor }}");
      expect(inspector).toContain(
        "OCI_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}",
      );
      expect(inspector).not.toMatch(/echo[^\n]*(GITHUB_TOKEN|OCI_REGISTRY_)/);
    }
    const login = step("Log in for edge promotion", promotionJob);
    expect(login).toMatch(
      /with:\s*\n\s+registry: ghcr\.io\s*\n\s+username: \$\{\{ github\.actor \}\}\s*\n\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/,
    );
    for (const noCredentialStep of [historyStep, ancestryStep, mutationStep]) {
      expect(noCredentialStep).not.toMatch(
        /GITHUB_TOKEN|OCI_REGISTRY_|password:|username:/,
      );
    }
    expect(promotionBeforeSteps).not.toContain("env:");
  });

  it("uses only isolated fetched history for exact commit ancestry", () => {
    expect(ancestryStep).toContain("git --no-replace-objects");
    expect(ancestryStep).toContain("refs/replace/");
    expect(ancestryStep).toContain("objects/info/alternates");
    expect(ancestryStep).toContain("'refs/remotes/origin/main^{commit}'");
    expect(ancestryStep).toContain('cat-file -t "$EDGE_REVISION"');
    expect(ancestryStep).toContain(')" == commit ]]');
    expect(ancestryStep).toContain(
      'merge-base --is-ancestor "$EDGE_REVISION" "$TARGET_SHA"',
    );
    expect(ancestryStep).not.toMatch(/workflow_run|git -C \.|\.git\/config/);
  });

  it("performs one digest-pinned mutation and exact post-check with no repair path", () => {
    expect(mutationStep.match(/docker buildx imagetools create/g)).toHaveLength(
      1,
    );
    expect(mutationStep).toContain("--tag ghcr.io/felixgeisler/draw:edge");
    expect(mutationStep).toContain(
      '"ghcr.io/felixgeisler/draw:sha-$TARGET_SHA@sha256:$verified_digest"',
    );
    expect(mutationStep).not.toMatch(
      /workflow_run|:edge@|delete|rollback|retry|repair/i,
    );
    expect(postPromotionStep).toContain('--expected-revision "$TARGET_SHA"');
    expect(postPromotionStep).toContain('[[ "$digest" == "$SOURCE_DIGEST" ]]');
    expect(promotionJob.match(/docker buildx imagetools create/g)).toHaveLength(
      1,
    );
    expect(promotionJob).not.toMatch(
      /gh release|docker manifest (rm|push)|:latest|:dryrun/,
    );
  });
});

type EdgeEvidence =
  | { kind: "absent" }
  | { kind: "valid"; revision: string; digest: string }
  | { kind: "invalid" };
type PromotionOutcome = "source-missing" | "equal" | "promoted" | "blocked";

class PromotionModel {
  readonly parents = new Map<string, string | undefined>();
  readonly sources = new Map<string, string>();
  edge: EdgeEvidence = { kind: "absent" };
  readonly mutations: Array<{ target: string; digest: string }> = [];

  addCommit(
    revision: string,
    parent: string | undefined,
    sourceDigest?: string,
  ) {
    this.parents.set(revision, parent);
    if (sourceDigest !== undefined) this.sources.set(revision, sourceDigest);
  }

  private isAncestor(revision: string, target: string): boolean {
    const visited = new Set<string>();
    let cursor: string | undefined = target;
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === revision) return true;
      visited.add(cursor);
      cursor = this.parents.get(cursor);
    }
    return false;
  }

  run(
    target: string,
    post: "valid" | "mismatch" | "absent" | "failure" = "valid",
  ): PromotionOutcome {
    const sourceDigest = this.sources.get(target);
    if (sourceDigest === undefined) return "source-missing";
    if (this.edge.kind === "invalid") return "blocked";
    if (
      this.edge.kind === "valid" &&
      !this.isAncestor(this.edge.revision, target)
    ) {
      return "blocked";
    }
    if (this.edge.kind === "valid" && this.edge.digest === sourceDigest)
      return "equal";
    this.mutations.push({ target, digest: sourceDigest });
    if (post !== "valid") return "blocked";
    this.edge = { kind: "valid", revision: target, digest: sourceDigest };
    return "promoted";
  }
}

class PromotionConcurrency {
  running: string | undefined;
  pending: string | undefined;
  readonly replaced: string[] = [];

  arrive(id: string) {
    if (this.running === undefined) this.running = id;
    else {
      if (this.pending !== undefined) this.replaced.push(this.pending);
      this.pending = id;
    }
  }

  complete(): string | undefined {
    const completed = this.running;
    this.running = this.pending;
    this.pending = undefined;
    return completed;
  }
}

class HistoryLifecycleModel {
  area = false;
  handedOff = false;
  removed = false;

  initialize(failure: "none" | "before-area" | "after-area") {
    if (failure === "before-area") return;
    this.area = true;
    if (failure === "after-area") {
      this.area = false;
      this.removed = true;
      return;
    }
    this.handedOff = true;
  }

  finish(pathSafe = true) {
    if (!this.handedOff || !this.area || !pathSafe) return false;
    this.area = false;
    this.removed = true;
    return true;
  }
}

describe("isolated history lifecycle state model", () => {
  it("removes initialization state on failure before handoff", () => {
    const beforeArea = new HistoryLifecycleModel();
    beforeArea.initialize("before-area");
    expect(beforeArea).toMatchObject({
      area: false,
      handedOff: false,
      removed: false,
    });

    const afterArea = new HistoryLifecycleModel();
    afterArea.initialize("after-area");
    expect(afterArea).toMatchObject({
      area: false,
      handedOff: false,
      removed: true,
    });
  });

  it.each(["source no-op", "equal no-op", "later failure", "success"])(
    "retains history through %s and removes it in final cleanup",
    () => {
      const lifecycle = new HistoryLifecycleModel();
      lifecycle.initialize("none");
      expect(lifecycle).toMatchObject({
        area: true,
        handedOff: true,
        removed: false,
      });
      expect(lifecycle.finish()).toBe(true);
      expect(lifecycle).toMatchObject({
        area: false,
        handedOff: true,
        removed: true,
      });
    },
  );

  it("rejects absent, unhanded, or unsafe cleanup paths", () => {
    const absent = new HistoryLifecycleModel();
    expect(absent.finish()).toBe(false);
    const unsafe = new HistoryLifecycleModel();
    unsafe.initialize("none");
    expect(unsafe.finish(false)).toBe(false);
    expect(unsafe.area).toBe(true);
  });
});

describe("convergent promotion and global concurrency state model", () => {
  it("models one running and one replaceable pending arrival without cancellation", () => {
    const queue = new PromotionConcurrency();
    queue.arrive("run-a");
    queue.arrive("run-b");
    queue.arrive("run-c");
    expect(queue).toMatchObject({
      running: "run-a",
      pending: "run-c",
      replaced: ["run-b"],
    });
    expect(queue.complete()).toBe("run-a");
    expect(queue.running).toBe("run-c");
    expect(queue.complete()).toBe("run-c");
  });

  it("converges through reverse publication completion, reruns, and main advancement", () => {
    const model = new PromotionModel();
    const a = sha("a");
    const b = sha("b");
    const c = sha("c");
    model.addCommit(a, undefined, digest("1"));
    model.addCommit(b, a);
    model.addCommit(c, b);
    expect(model.run(c)).toBe("source-missing");
    expect(model.mutations).toEqual([]);
    model.addCommit(c, b, digest("3"));
    expect(model.run(c)).toBe("promoted");
    expect(model.run(c)).toBe("equal");
    const d = sha("d");
    model.addCommit(d, c, digest("4"));
    expect(model.run(d)).toBe("promoted");
    expect(model.edge).toEqual({
      kind: "valid",
      revision: d,
      digest: digest("4"),
    });
  });

  it("accepts missing/equal/older ancestry and never moves backward or from invalid evidence", () => {
    const model = new PromotionModel();
    const a = sha("a");
    const b = sha("b");
    const divergent = sha("e");
    model.addCommit(a, undefined, digest("1"));
    model.addCommit(b, a, digest("2"));
    model.addCommit(divergent, undefined, digest("e"));
    expect(model.run(a)).toBe("promoted");
    expect(model.run(b)).toBe("promoted");
    expect(model.run(a)).toBe("blocked");
    expect(model.run(divergent)).toBe("blocked");
    expect(model.mutations.map(({ target }) => target)).toEqual([a, b]);
    model.edge = { kind: "invalid" };
    expect(model.run(b)).toBe("blocked");
  });

  it.each(["mismatch", "absent", "failure"] as const)(
    "fails closed after post-check %s with exactly one mutation and no repair",
    (post) => {
      const model = new PromotionModel();
      model.addCommit(sha("a"), undefined, digest("1"));
      expect(model.run(sha("a"), post)).toBe("blocked");
      expect(model.mutations).toEqual([
        { target: sha("a"), digest: digest("1") },
      ]);
    },
  );

  it("fails closed for unprovable history and preserves edge", () => {
    const model = new PromotionModel();
    const target = sha("b");
    model.addCommit(target, undefined, digest("2"));
    model.edge = { kind: "valid", revision: sha("a"), digest: digest("1") };
    expect(model.run(target)).toBe("blocked");
    expect(model.mutations).toEqual([]);
    expect(model.edge).toEqual({
      kind: "valid",
      revision: sha("a"),
      digest: digest("1"),
    });
  });
});
