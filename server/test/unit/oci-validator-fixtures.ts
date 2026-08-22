import { createHash } from "node:crypto";

export const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
export const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
export const REVISION = "0123456789abcdef0123456789abcdef01234567";

const encoder = new TextEncoder();

export function bytes(value: unknown): Uint8Array {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
}

export function digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function descriptor(mediaType: string, body: Uint8Array, extra: Record<string, unknown> = {}) {
  return { mediaType, digest: digest(body), size: body.length, ...extra };
}

export type FixtureOptions = {
  reverseDescriptors?: boolean;
  revision?: string;
  amd64ConfigRevision?: string;
  arm64ConfigRevision?: string;
  mutateIndex?: (index: Record<string, any>) => void;
  mutateAmd64Manifest?: (manifest: Record<string, any>) => void;
  mutateArm64Manifest?: (manifest: Record<string, any>) => void;
  mutateAmd64Config?: (config: Record<string, any>) => void;
  mutateArm64Config?: (config: Record<string, any>) => void;
};

export function makeFixture(options: FixtureOptions = {}) {
  const revision = options.revision ?? REVISION;
  const amd64Config = {
    architecture: "amd64",
    os: "linux",
    config: { Labels: { "org.opencontainers.image.revision": options.amd64ConfigRevision ?? revision } },
  };
  const arm64Config = {
    architecture: "arm64",
    os: "linux",
    config: { Labels: { "org.opencontainers.image.revision": options.arm64ConfigRevision ?? revision } },
  };
  options.mutateAmd64Config?.(amd64Config);
  options.mutateArm64Config?.(arm64Config);
  const amd64ConfigBody = bytes(amd64Config);
  const arm64ConfigBody = bytes(arm64Config);

  const layer = (seed: string) => ({
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: `sha256:${seed.repeat(64)}`,
    size: 123,
    annotations: { "org.example.note": "not fetched" },
  });
  const amd64Manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: descriptor(CONFIG_MEDIA_TYPE, amd64ConfigBody),
    layers: [layer("a")],
  };
  const arm64Manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: descriptor(CONFIG_MEDIA_TYPE, arm64ConfigBody),
    layers: [layer("b")],
  };
  options.mutateAmd64Manifest?.(amd64Manifest);
  options.mutateArm64Manifest?.(arm64Manifest);
  const amd64ManifestBody = bytes(amd64Manifest);
  const arm64ManifestBody = bytes(arm64Manifest);

  const amd64Descriptor = descriptor(MANIFEST_MEDIA_TYPE, amd64ManifestBody, {
    platform: { os: "linux", architecture: "amd64" },
  });
  const arm64Descriptor = descriptor(MANIFEST_MEDIA_TYPE, arm64ManifestBody, {
    platform: { os: "linux", architecture: "arm64" },
  });
  const index = {
    schemaVersion: 2,
    mediaType: INDEX_MEDIA_TYPE,
    annotations: {
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.source": "https://github.com/FelixGeisler/draw",
    },
    manifests: options.reverseDescriptors
      ? [arm64Descriptor, amd64Descriptor]
      : [amd64Descriptor, arm64Descriptor],
  };
  options.mutateIndex?.(index);
  const indexBody = bytes(index);
  const indexDigest = digest(indexBody);

  const headers = (contentType: string, dockerContentDigest: string[] = []) => ({
    contentType: [contentType],
    contentEncoding: [],
    dockerContentDigest,
  });
  const record = (
    stage: string,
    endpoint: string,
    platform: string | null,
    requestedDigest: string | null,
    expectedMediaType: string,
    expectedSize: number | null,
    body: Uint8Array,
    contentType: string,
    dockerContentDigest: string[] = [],
  ) => ({
    stage,
    endpoint,
    platform,
    requestedDigest,
    expectedMediaType,
    expectedSize,
    status: 200,
    headers: headers(contentType, dockerContentDigest),
    body,
  });

  const records = [
    record("named-index", "manifests", null, null, INDEX_MEDIA_TYPE, null, indexBody, INDEX_MEDIA_TYPE, [indexDigest]),
    record("digest-index", "manifests", null, indexDigest, INDEX_MEDIA_TYPE, null, indexBody, INDEX_MEDIA_TYPE),
    record("amd64-manifest", "manifests", "linux/amd64", digest(amd64ManifestBody), MANIFEST_MEDIA_TYPE, amd64ManifestBody.length, amd64ManifestBody, MANIFEST_MEDIA_TYPE),
    record("amd64-config", "blobs", "linux/amd64", digest(amd64ConfigBody), CONFIG_MEDIA_TYPE, amd64ConfigBody.length, amd64ConfigBody, "application/octet-stream"),
    record("arm64-manifest", "manifests", "linux/arm64", digest(arm64ManifestBody), MANIFEST_MEDIA_TYPE, arm64ManifestBody.length, arm64ManifestBody, MANIFEST_MEDIA_TYPE),
    record("arm64-config", "blobs", "linux/arm64", digest(arm64ConfigBody), CONFIG_MEDIA_TYPE, arm64ConfigBody.length, arm64ConfigBody, "application/octet-stream"),
  ];

  return { revision, digest: indexDigest, records };
}

export function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}
