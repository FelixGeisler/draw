import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import webPush from "web-push";

export const VAPID_SUBJECT = "https://github.com/FelixGeisler/draw";
export const AUTHORITY_FILE = "push-authority.json";
export const RESET_MARKER = "push-authority-reset-pending";
export const RESTORE_MARKER = "push-restore-pending";
export const REVOKE_MARKER = "push-revoke-pending";
const MAX_AUTHORITY_BYTES = 8_192;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 67_108_864 } as const;

export type PushUnavailableReason = "not-production" | "authority-unavailable" | "recovery-pending";
export interface PushSnapshot {
  available: boolean;
  reason: PushUnavailableReason | null;
  publicVapidKey: string | null;
  generation: string | null;
}

export interface PushDependency {
  snapshot(): PushSnapshot;
  generation(): string | null;
  invalidate(): void;
  reset(): void;
  beginRestore(): void;
  completeRestore(): void;
  abortRestore(): void;
}

export const disabledPushDependency: PushDependency = Object.freeze({
  snapshot: () => ({
    available: false,
    reason: "not-production" as const,
    publicVapidKey: null,
    generation: null,
  }),
  generation: () => null,
  invalidate: () => {},
  reset: () => {},
  beginRestore: () => {},
  completeRestore: () => {},
  abortRestore: () => {},
});

type PasswordRecord =
  | { kind: "none" }
  | {
      kind: "scrypt";
      salt: string;
      verifier: string;
      params: typeof SCRYPT_PARAMS;
    };

export interface AuthorityDocument {
  version: 1;
  generation: string;
  vapid: { publicKey: string; privateKey: string };
  password: PasswordRecord;
}

export interface PushLifecycleOptions {
  dataDir: string;
  /** Already-resolved resolvePassword() output; never pass raw DRAW_PASSWORD. */
  password?: string;
  deleteSubscriptions: () => void;
  randomBytes?: (size: number) => Buffer;
  generateVapidKeys?: () => { publicKey: string; privateKey: string };
  /** Test-only synchronous crash/failure seam. */
  fault?: (point: string) => void;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalBase64url(value: unknown, bytes: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}

function passwordRecord(password: string | undefined, randomBytes: (size: number) => Buffer): PasswordRecord {
  if (password === undefined) return { kind: "none" };
  const salt = randomBytes(16);
  const verifier = crypto.scryptSync(Buffer.from(password, "utf8"), salt, 32, SCRYPT_PARAMS);
  return {
    kind: "scrypt",
    salt: salt.toString("base64url"),
    verifier: verifier.toString("base64url"),
    params: { ...SCRYPT_PARAMS },
  };
}

function validatePasswordRecord(value: unknown): PasswordRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid password record");
  const record = value as Record<string, unknown>;
  if (record.kind === "none") {
    if (!exactKeys(record, ["kind"])) throw new Error("invalid none password record");
    return { kind: "none" };
  }
  if (record.kind !== "scrypt" || !exactKeys(record, ["kind", "salt", "verifier", "params"])) {
    throw new Error("invalid scrypt password record");
  }
  const params = record.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("invalid scrypt params");
  const p = params as Record<string, unknown>;
  if (
    !exactKeys(p, ["N", "r", "p", "maxmem"]) ||
    p.N !== SCRYPT_PARAMS.N ||
    p.r !== SCRYPT_PARAMS.r ||
    p.p !== SCRYPT_PARAMS.p ||
    p.maxmem !== SCRYPT_PARAMS.maxmem
  ) {
    throw new Error("unsupported scrypt params");
  }
  canonicalBase64url(record.salt, 16);
  canonicalBase64url(record.verifier, 32);
  return {
    kind: "scrypt",
    salt: record.salt as string,
    verifier: record.verifier as string,
    params: { ...SCRYPT_PARAMS },
  };
}

/** Complete closed-document validation, including scalar/point/pair validity. */
export function validateAuthorityDocument(value: unknown): AuthorityDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid authority document");
  const document = value as Record<string, unknown>;
  if (!exactKeys(document, ["version", "generation", "vapid", "password"]) || document.version !== 1) {
    throw new Error("unsupported authority document");
  }
  const generation = canonicalBase64url(document.generation, 16);
  if (generation.length !== 16) throw new Error("invalid generation");
  if (!document.vapid || typeof document.vapid !== "object" || Array.isArray(document.vapid)) {
    throw new Error("invalid VAPID record");
  }
  const vapid = document.vapid as Record<string, unknown>;
  if (!exactKeys(vapid, ["publicKey", "privateKey"])) throw new Error("invalid VAPID fields");
  const publicKey = canonicalBase64url(vapid.publicKey, 65);
  const privateKey = canonicalBase64url(vapid.privateKey, 32);
  if (publicKey[0] !== 0x04) throw new Error("VAPID public key is not uncompressed P-256");

  // Node/OpenSSL owns scalar and curve validation. Derivation additionally
  // proves the individually valid public/private values are one pair.
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const normalizedPublic = Buffer.from(
    crypto.ECDH.convertKey(publicKey, "prime256v1", undefined, undefined, "uncompressed"),
  );
  const derivedPublic = ecdh.getPublicKey(undefined, "uncompressed");
  if (
    normalizedPublic.length !== derivedPublic.length ||
    !crypto.timingSafeEqual(normalizedPublic, derivedPublic)
  ) {
    throw new Error("VAPID public/private key mismatch");
  }

  return {
    version: 1,
    generation: document.generation as string,
    vapid: { publicKey: vapid.publicKey as string, privateKey: vapid.privateKey as string },
    password: validatePasswordRecord(document.password),
  };
}

function parseAuthority(bytes: Buffer): AuthorityDocument {
  if (bytes.length > MAX_AUTHORITY_BYTES) throw new Error("authority file is oversized");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return validateAuthorityDocument(JSON.parse(text) as unknown);
}

function passwordMatches(record: PasswordRecord, password: string | undefined): boolean {
  if (record.kind === "none") return password === undefined;
  if (password === undefined) return false;
  const salt = canonicalBase64url(record.salt, 16);
  const expected = canonicalBase64url(record.verifier, 32);
  const actual = crypto.scryptSync(Buffer.from(password, "utf8"), salt, 32, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on Windows. File fsync + same-directory
    // atomic rename remains the strongest portable primitive available.
  }
}

function rejectUnsafeTarget(target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path.basename(target)} is not a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function atomicWrite(target: string, bytes: Buffer, fault?: (point: string) => void): void {
  rejectUnsafeTarget(target);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fault?.("temp-create");
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fault?.("write");
    fs.writeFileSync(fd, bytes);
    fault?.("file-fsync");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fault?.("rename");
    rejectUnsafeTarget(target);
    fs.renameSync(temporary, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Windows access is additionally protected by the private DATA_DIR ACL.
    }
    try {
      fault?.("directory-fsync");
      fsyncDirectoryBestEffort(directory);
    } catch {
      // Directory fsync is explicitly best-effort on supported platforms.
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function markerState(marker: string): "absent" | "valid" | "invalid" {
  try {
    const stat = fs.lstatSync(marker);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0 ? "valid" : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "invalid";
  }
}

function createMarker(marker: string, fault?: (point: string) => void): void {
  const state = markerState(marker);
  if (state === "invalid") throw new Error("invalid Push recovery marker");
  if (state === "valid") return;
  atomicWrite(marker, Buffer.alloc(0), fault);
}

function removeMarker(marker: string, fault?: (point: string) => void): void {
  if (markerState(marker) === "invalid") throw new Error("invalid Push recovery marker");
  fault?.("marker-remove");
  fs.rmSync(marker, { force: true });
  fsyncDirectoryBestEffort(path.dirname(marker));
}

function readAuthority(authorityPath: string): AuthorityDocument | null {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(authorityPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("authority is not a regular file");
  if (before.size > BigInt(MAX_AUTHORITY_BYTES)) throw new Error("authority file is oversized");
  if (before.dev === 0n || before.ino === 0n) throw new Error("authority identity cannot be proven");

  const noFollow = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const fd = fs.openSync(authorityPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    const afterDescriptor = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(authorityPath, { bigint: true });
    const stable = (left: fs.BigIntStats, right: fs.BigIntStats) =>
      left.isFile() &&
      !left.isSymbolicLink() &&
      right.isFile() &&
      !right.isSymbolicLink() &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.nlink === right.nlink &&
      left.size === right.size;
    if (!stable(before, opened) || !stable(opened, afterDescriptor) || !stable(afterDescriptor, afterPath)) {
      throw new Error("authority changed while reading");
    }
    return parseAuthority(bytes);
  } finally {
    fs.closeSync(fd);
  }
}

export class PushLifecycle implements PushDependency {
  private readonly authorityPath: string;
  private readonly resetMarkerPath: string;
  private readonly restoreMarkerPath: string;
  private readonly revokeMarkerPath: string;
  private workVersion = 0;
  private state: PushSnapshot = {
    available: false,
    reason: "authority-unavailable",
    publicVapidKey: null,
    generation: null,
  };
  private pendingCandidate: AuthorityDocument | null = null;
  private preRestoreState: PushSnapshot | null = null;

  constructor(private readonly options: PushLifecycleOptions) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    this.authorityPath = path.join(options.dataDir, AUTHORITY_FILE);
    this.resetMarkerPath = path.join(options.dataDir, RESET_MARKER);
    this.restoreMarkerPath = path.join(options.dataDir, RESTORE_MARKER);
    this.revokeMarkerPath = path.join(options.dataDir, REVOKE_MARKER);
    this.boot();
  }

  snapshot(): PushSnapshot {
    return { ...this.state };
  }

  generation(): string | null {
    return this.state.available ? this.state.generation : null;
  }

  invalidate(): void {
    this.state = { available: false, reason: "recovery-pending", publicVapidKey: null, generation: null };
  }

  currentWorkGeneration(): number {
    return this.workVersion;
  }

  advanceWorkGeneration(): void {
    this.workVersion += 1;
  }

  private candidate(): AuthorityDocument {
    this.options.fault?.("generation");
    const random = this.options.randomBytes ?? crypto.randomBytes;
    const vapid = (this.options.generateVapidKeys ?? webPush.generateVAPIDKeys)();
    const candidate: AuthorityDocument = {
      version: 1,
      generation: random(16).toString("base64url"),
      vapid,
      password: passwordRecord(this.options.password, random),
    };
    return validateAuthorityDocument(candidate);
  }

  private makeAvailable(authority: AuthorityDocument): void {
    this.state = {
      available: true,
      reason: null,
      publicVapidKey: authority.vapid.publicKey,
      generation: authority.generation,
    };
  }

  private install(authority: AuthorityDocument): void {
    const bytes = Buffer.from(JSON.stringify(authority), "utf8");
    if (bytes.length > MAX_AUTHORITY_BYTES) throw new Error("authority candidate is oversized");
    atomicWrite(this.authorityPath, bytes, this.options.fault);
  }

  private clearSubscriptions(): void {
    this.options.fault?.("subscriptions-delete");
    this.options.deleteSubscriptions();
  }

  private recover(markers: string[]): void {
    const candidate = this.candidate();
    this.advanceWorkGeneration();
    this.invalidate();
    this.options.fault?.("recovery-after-invalidate");
    this.clearSubscriptions();
    this.options.fault?.("recovery-after-delete");
    this.install(candidate);
    this.options.fault?.("recovery-after-install");
    for (const marker of markers) removeMarker(marker, this.options.fault);
    this.makeAvailable(candidate);
  }

  private boot(): void {
    const reset = markerState(this.resetMarkerPath);
    const restore = markerState(this.restoreMarkerPath);
    const revoke = markerState(this.revokeMarkerPath);
    if (reset === "invalid" || restore === "invalid" || revoke === "invalid") {
      this.state = { available: false, reason: "recovery-pending", publicVapidKey: null, generation: null };
      return;
    }
    const markers = [
      ...(reset === "valid" ? [this.resetMarkerPath] : []),
      ...(restore === "valid" ? [this.restoreMarkerPath] : []),
      ...(revoke === "valid" ? [this.revokeMarkerPath] : []),
    ];
    if (markers.length > 0) {
      try {
        this.recover(markers);
      } catch {
        this.invalidate();
      }
      return;
    }

    let authority: AuthorityDocument | null;
    try {
      authority = readAuthority(this.authorityPath);
    } catch {
      // Ordinary malformed/unreadable authority is evidence, not permission
      // to overwrite it. Draw remains usable while Push fails closed.
      this.state = { available: false, reason: "authority-unavailable", publicVapidKey: null, generation: null };
      return;
    }
    if (authority && passwordMatches(authority.password, this.options.password)) {
      this.makeAvailable(authority);
      return;
    }
    try {
      this.pendingCandidate = this.candidate();
      createMarker(this.resetMarkerPath, this.options.fault);
      this.options.fault?.("reset-after-marker");
      this.invalidate();
      this.options.fault?.("reset-after-invalidate");
      this.clearSubscriptions();
      this.options.fault?.("reset-after-delete");
      this.install(this.pendingCandidate);
      this.options.fault?.("reset-after-install");
      removeMarker(this.resetMarkerPath, this.options.fault);
      this.makeAvailable(this.pendingCandidate);
      this.pendingCandidate = null;
    } catch {
      this.state = {
        available: false,
        reason: markerState(this.resetMarkerPath) === "valid" ? "recovery-pending" : "authority-unavailable",
        publicVapidKey: null,
        generation: null,
      };
    }
  }

  reset(): void {
    const candidate = this.candidate();
    this.advanceWorkGeneration();
    try {
      createMarker(this.resetMarkerPath, this.options.fault);
      this.options.fault?.("reset-after-marker");
      this.invalidate();
      this.options.fault?.("reset-after-invalidate");
      this.clearSubscriptions();
      this.options.fault?.("reset-after-delete");
      this.install(candidate);
      this.options.fault?.("reset-after-install");
      removeMarker(this.resetMarkerPath, this.options.fault);
      this.makeAvailable(candidate);
    } catch (error) {
      if (markerState(this.resetMarkerPath) === "valid") this.invalidate();
      throw error;
    }
  }

  revokeAll(): void {
    const candidate = this.candidate();
    const previous = this.snapshot();
    let deleted = false;
    createMarker(this.revokeMarkerPath, this.options.fault);
    try {
      this.options.fault?.("revoke-after-marker");
      this.advanceWorkGeneration();
      this.invalidate();
      this.options.fault?.("revoke-after-invalidate");
      this.clearSubscriptions();
      deleted = true;
      this.options.fault?.("revoke-after-delete");
      this.options.fault?.("revoke-install");
      this.install(candidate);
      this.options.fault?.("revoke-after-install");
      removeMarker(this.revokeMarkerPath, this.options.fault);
      this.makeAvailable(candidate);
    } catch (error) {
      if (!deleted) {
        try {
          removeMarker(this.revokeMarkerPath, this.options.fault);
          this.state = previous;
        } catch {
          this.invalidate();
        }
      } else {
        this.invalidate();
      }
      throw error;
    }
  }

  beginRestore(): void {
    if (
      markerState(this.resetMarkerPath) !== "absent" ||
      markerState(this.restoreMarkerPath) !== "absent" ||
      markerState(this.revokeMarkerPath) !== "absent"
    ) {
      throw new Error("Push recovery is already pending");
    }
    this.pendingCandidate = this.candidate();
    this.preRestoreState = this.snapshot();
    try {
      this.advanceWorkGeneration();
      this.invalidate();
      this.options.fault?.("restore-after-invalidate");
      createMarker(this.restoreMarkerPath, this.options.fault);
      this.options.fault?.("restore-after-marker");
    } catch (error) {
      try {
        if (markerState(this.restoreMarkerPath) === "valid") {
          removeMarker(this.restoreMarkerPath, this.options.fault);
        }
        this.state = this.preRestoreState;
      } catch {
        this.invalidate();
      }
      this.preRestoreState = null;
      this.pendingCandidate = null;
      throw error;
    }
  }

  completeRestore(): void {
    if (!this.pendingCandidate || markerState(this.restoreMarkerPath) !== "valid") {
      throw new Error("Push restore marker/candidate missing");
    }
    this.invalidate();
    this.clearSubscriptions();
    this.options.fault?.("restore-finalize-after-delete");
    // The valid marker authorizes replacement even if the old authority is
    // malformed; atomicWrite still refuses a symlink/non-regular target.
    this.install(this.pendingCandidate);
    this.options.fault?.("restore-finalize-after-install");
    removeMarker(this.restoreMarkerPath, this.options.fault);
    this.makeAvailable(this.pendingCandidate);
    this.pendingCandidate = null;
    this.preRestoreState = null;
  }

  abortRestore(): void {
    try {
      removeMarker(this.restoreMarkerPath, this.options.fault);
      if (this.preRestoreState) this.state = this.preRestoreState;
      this.pendingCandidate = null;
      this.preRestoreState = null;
    } catch {
      this.invalidate();
      throw new Error("Push restore rollback could not be proven durable");
    }
  }
}
