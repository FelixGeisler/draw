import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  GhcrImageNotFoundError,
  inspectGhcrImage,
} from "./lib/ghcr-http-client.mjs";

const IMAGE_PREFIX = "ghcr.io/felixgeisler/draw:";
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[0-9a-f]{40}$/;
const OVERALL_TIMEOUT_MS = 90_000;

class UsageError extends Error {}

function usage(message) {
  throw new UsageError(message);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || (argv.length !== 2 && argv.length !== 4) ||
      argv[0] !== "--image" || typeof argv[1] !== "string" ||
      (argv.length === 4 && (argv[2] !== "--expected-revision" || typeof argv[3] !== "string"))) {
    usage("usage: inspect-oci-image --image <reference> [--expected-revision <revision>]");
  }
  const reference = argv[1];
  if (!reference.startsWith(IMAGE_PREFIX)) usage("invalid image reference");
  const tag = reference.slice(IMAGE_PREFIX.length);
  if (!TAG.test(tag)) usage("invalid image reference");
  const expectedRevision = argv.length === 4 ? argv[3] : undefined;
  if (expectedRevision !== undefined && !REVISION.test(expectedRevision)) usage("invalid expected revision");
  return { tag, expectedRevision };
}

function visibleAscii(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function parseCredentials(env) {
  const username = env?.OCI_REGISTRY_USERNAME;
  const password = env?.OCI_REGISTRY_PASSWORD;
  if (username === undefined && password === undefined) return null;
  if (!visibleAscii(username) || !visibleAscii(password) || username.includes(":")) {
    usage("invalid registry credentials");
  }
  return { username, password };
}

function boundedLine(message) {
  const clean = String(message).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "failure";
  const suffix = "\n";
  const maximum = 512 - Buffer.byteLength(suffix);
  let line = clean;
  while (Buffer.byteLength(line) > maximum) line = line.slice(0, -1);
  return `${line}${suffix}`;
}

export async function runCli({ argv, env, stdout, stderr, transport, signals }) {
  let parsed;
  let credentials;
  try {
    parsed = parseArguments(argv);
    credentials = parseCredentials(env);
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "invalid command input";
    stderr.write(boundedLine(message));
    return 2;
  }

  const overallController = new AbortController();
  const onSignal = () => overallController.abort();
  let overallTimer;
  try {
    if (typeof transport !== "function" || !signals || typeof signals.on !== "function" || typeof signals.off !== "function") {
      throw new Error("invalid runner dependency");
    }
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    const startOverallDeadline = () => {
      if (overallTimer === undefined) overallTimer = setTimeout(() => overallController.abort(), OVERALL_TIMEOUT_MS);
    };
    const result = await inspectGhcrImage({
      tag: parsed.tag,
      expectedRevision: parsed.expectedRevision,
      credentials,
      transport,
      overallSignal: overallController.signal,
      startOverallDeadline,
    });
    stdout.write(`${JSON.stringify({ digest: result.digest, revision: result.revision })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof GhcrImageNotFoundError) {
      stderr.write("image not found\n");
      return 3;
    }
    stderr.write(boundedLine("inspection failed: request or image validation failed"));
    return 1;
  } finally {
    if (overallTimer !== undefined) clearTimeout(overallTimer);
    if (signals && typeof signals.off === "function") {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
    }
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    transport: globalThis.fetch,
    signals: process,
  }).then((code) => {
    process.exitCode = code;
  });
}
