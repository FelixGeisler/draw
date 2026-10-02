import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { schemaSqlTokens } from "./schemaV18.js";
import { RESTORE_SCHEMA_OBJECTS, RESTORE_SCHEMA_VERSIONS } from "./restoreSchemaManifest.js";

const MAX_SCHEMA_OBJECTS = 96;
const MAX_SCHEMA_NAME_BYTES = 128;

type SchemaMetadata = {
  type: string;
  name: string | null;
  tableName: string | null;
  rootPage: number;
  sqlType: string;
  sqlBytes: number;
};

type ObjectContract = readonly [
  type: string,
  name: string,
  tableName: string,
  hasRootPage: 0 | 1,
  maxSqlBytes: number,
  ...sqlHashes: string[],
];

function contractKey(type: string, name: string): string {
  return `${type}\0${name}`;
}

function normalizedHash(sql: string): string {
  return crypto
    .createHash("sha256")
    .update(schemaSqlTokens(sql).join("\0"))
    .digest("hex");
}

/**
 * Admit only the checked-in schema for a stamped v1-v24 staged database.
 * The first read is bounded scalar metadata only. SQL text is fetched one
 * known object at a time, and only after its per-object byte cap is proven.
 */
export function preflightRestoreSchema(database: Database.Database, version: number): void {
  const objectIds = RESTORE_SCHEMA_VERSIONS[version];
  if (!objectIds) throw new Error(`unsupported schema version ${version}`);
  const contracts = objectIds.map((id) => RESTORE_SCHEMA_OBJECTS[id] as ObjectContract);
  const expected = new Map(contracts.map((contract) => [contractKey(contract[0], contract[1]), contract]));

  const metadata = database
    .prepare(
      `SELECT type,
              CASE WHEN typeof(name)='text' AND octet_length(name)<=? THEN name END AS name,
              CASE WHEN typeof(tbl_name)='text' AND octet_length(tbl_name)<=? THEN tbl_name END AS tableName,
              rootpage AS rootPage,
              typeof(sql) AS sqlType,
              CASE WHEN sql IS NULL THEN 0 ELSE octet_length(sql) END AS sqlBytes
       FROM sqlite_schema
       ORDER BY type,name
       LIMIT ?`,
    )
    .all(MAX_SCHEMA_NAME_BYTES, MAX_SCHEMA_NAME_BYTES, MAX_SCHEMA_OBJECTS + 1) as SchemaMetadata[];

  if (metadata.length > MAX_SCHEMA_OBJECTS) throw new Error("schema inventory is too large");
  if (metadata.length !== contracts.length) throw new Error("schema inventory mismatch");

  const seen = new Set<string>();
  for (const object of metadata) {
    if (
      object.name === null ||
      object.tableName === null ||
      !Number.isInteger(object.rootPage) ||
      object.rootPage < 0 ||
      !Number.isInteger(object.sqlBytes) ||
      object.sqlBytes < 0
    ) {
      throw new Error("schema metadata is malformed or oversized");
    }
    const key = contractKey(object.type, object.name);
    const contract = expected.get(key);
    if (!contract || seen.has(key)) {
      // Unknown views, triggers, virtual tables, shadow-like names, ordinary
      // tables and indexes all stop here; their SQL is never fetched.
      throw new Error(`unknown schema object ${object.type}:${object.name}`);
    }
    seen.add(key);
    const [, , expectedTable, hasRootPage, maxSqlBytes, ...hashes] = contract;
    if (object.tableName !== expectedTable) throw new Error(`schema owner mismatch: ${object.name}`);
    if ((object.rootPage > 0 ? 1 : 0) !== hasRootPage) {
      throw new Error(`schema root-page mismatch: ${object.name}`);
    }
    if (hashes.length === 0) {
      if (object.sqlType !== "null" || object.sqlBytes !== 0) {
        throw new Error(`schema SQL mismatch: ${object.name}`);
      }
      continue;
    }
    if (object.sqlType !== "text" || object.sqlBytes > maxSqlBytes) {
      throw new Error(`schema SQL is malformed or oversized: ${object.name}`);
    }
  }
  if (seen.size !== expected.size) throw new Error("schema inventory is incomplete");

  for (const contract of contracts) {
    const [type, name, , , maxSqlBytes, ...hashes] = contract;
    if (hashes.length === 0) continue;
    const row = database
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type=? AND name=? AND typeof(sql)='text' AND octet_length(sql)<=?`,
      )
      .get(type, name, maxSqlBytes) as { sql: string } | undefined;
    if (!row || !hashes.includes(normalizedHash(row.sql))) {
      throw new Error(`schema definition mismatch: ${name}`);
    }
  }
}
