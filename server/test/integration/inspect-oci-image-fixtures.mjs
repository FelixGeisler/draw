import { createHash } from "node:crypto";

export const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
export const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
export const REVISION = "0123456789abcdef0123456789abcdef01234567";

const encoder = new TextEncoder();

export function bytes(value) {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
}

export function digest(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function descriptor(mediaType, body, extra = {}) {
  return { mediaType, digest: digest(body), size: body.length, ...extra };
}

export function makeInspectionFixture({ reverseDescriptors = false, revision = REVISION, tag = "edge" } = {}) {
  const configBody = (architecture) => bytes({
    architecture,
    os: "linux",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
  });
  const amd64Config = configBody("amd64");
  const arm64Config = configBody("arm64");
  const manifestBody = (architecture, config) => bytes({
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: descriptor(CONFIG_MEDIA_TYPE, config),
    layers: [{
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: `sha256:${architecture === "amd64" ? "a" : "b"}`.padEnd(71, architecture === "amd64" ? "a" : "b"),
      size: 123,
    }],
  });
  const amd64Manifest = manifestBody("amd64", amd64Config);
  const arm64Manifest = manifestBody("arm64", arm64Config);
  const descriptors = [
    descriptor(MANIFEST_MEDIA_TYPE, amd64Manifest, { platform: { os: "linux", architecture: "amd64" } }),
    descriptor(MANIFEST_MEDIA_TYPE, arm64Manifest, { platform: { os: "linux", architecture: "arm64" } }),
  ];
  const index = bytes({
    schemaVersion: 2,
    mediaType: INDEX_MEDIA_TYPE,
    annotations: { "org.opencontainers.image.revision": revision },
    manifests: reverseDescriptors ? descriptors.reverse() : descriptors,
  });
  const indexDigest = digest(index);
  const artifacts = new Map([
    [`/v2/felixgeisler/draw/manifests/${tag}`, { body: index, contentType: INDEX_MEDIA_TYPE, dockerDigest: indexDigest }],
    [`/v2/felixgeisler/draw/manifests/${indexDigest}`, { body: index, contentType: INDEX_MEDIA_TYPE, dockerDigest: indexDigest }],
    [`/v2/felixgeisler/draw/manifests/${digest(amd64Manifest)}`, { body: amd64Manifest, contentType: MANIFEST_MEDIA_TYPE, dockerDigest: digest(amd64Manifest) }],
    [`/v2/felixgeisler/draw/blobs/${digest(amd64Config)}`, { body: amd64Config, contentType: "application/octet-stream", dockerDigest: digest(amd64Config) }],
    [`/v2/felixgeisler/draw/manifests/${digest(arm64Manifest)}`, { body: arm64Manifest, contentType: MANIFEST_MEDIA_TYPE, dockerDigest: digest(arm64Manifest) }],
    [`/v2/felixgeisler/draw/blobs/${digest(arm64Config)}`, { body: arm64Config, contentType: "application/octet-stream", dockerDigest: digest(arm64Config) }],
  ]);
  return { tag, revision, digest: indexDigest, artifacts };
}

export function distributionError(code, message = "fixture error", detail) {
  const entry = detail === undefined ? { code, message } : { code, message, detail };
  return bytes({ errors: [entry] });
}
