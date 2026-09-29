import type Database from "better-sqlite3";

export interface SafeRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SafeStatement {
  run(...bindings: unknown[]): SafeRunResult;
  get(...bindings: unknown[]): Record<string, unknown> | undefined;
  all(...bindings: unknown[]): Record<string, unknown>[];
}

export interface SafeTransaction<A extends unknown[], R> {
  (...args: A): R;
  deferred(...args: A): R;
  immediate(...args: A): R;
  exclusive(...args: A): R;
}

export interface SafeDatabase {
  prepare(sql: string): SafeStatement;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SafeTransaction<A, R>;
}

type TokenKind = "word" | "identifier" | "string" | "blob" | "parameter" | "symbol";
interface SqlToken {
  kind: TokenKind;
  value: string;
}

const FIRST_TOKENS = new Set(["select", "with", "insert", "update", "delete", "replace"]);
const FORBIDDEN_WORDS = new Set([
  "alter",
  "create",
  "drop",
  "vacuum",
  "reindex",
  "analyze",
  "attach",
  "detach",
  "pragma",
]);
const PROTECTED_EXACT = new Set([
  "week_access_state",
  "week_interval_access",
  "week_interval_rtree",
  "week_interval_rtree_node",
  "week_interval_rtree_parent",
  "week_interval_rtree_rowid",
  "database_list",
  "dbstat",
  "dbpage",
  "sqlite_dbdata",
  "sqlite_dbpage",
  "sqlite_dbptr",
  "sqlite_stmt",
  "bytecode",
  "load_extension",
  "eval",
  "readfile",
  "writefile",
]);

function isProtected(value: string): boolean {
  const folded = value.toLowerCase();
  return (
    PROTECTED_EXACT.has(folded) ||
    folded.startsWith("pragma_") ||
    folded.startsWith("sqlite_")
  );
}

function quotedToken(sql: string, start: number, delimiter: "'" | '"' | "`"): [string, number] {
  let value = "";
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== delimiter) {
      value += sql[index];
      continue;
    }
    if (sql[index + 1] === delimiter) {
      value += delimiter;
      index += 1;
      continue;
    }
    return [value, index + 1];
  }
  throw new Error("unsafe SQL: unterminated quoted token");
}

function bracketToken(sql: string, start: number): [string, number] {
  let value = "";
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== "]") {
      value += sql[index];
      continue;
    }
    if (sql[index + 1] === "]") {
      value += "]";
      index += 1;
      continue;
    }
    return [value, index + 1];
  }
  throw new Error("unsafe SQL: unterminated bracket identifier");
}

function tokenize(sql: string): SqlToken[] {
  if (sql.includes("\0")) throw new Error("unsafe SQL: NUL byte");
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length; ) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("unsafe SQL: unterminated block comment");
      index = end + 2;
      continue;
    }
    if (char === "'") {
      const [value, next] = quotedToken(sql, index, "'");
      tokens.push({ kind: "string", value });
      index = next;
      continue;
    }
    if (char === '"' || char === "`") {
      const [value, next] = quotedToken(sql, index, char);
      tokens.push({ kind: "identifier", value });
      index = next;
      continue;
    }
    if (char === "[") {
      const [value, next] = bracketToken(sql, index);
      tokens.push({ kind: "identifier", value });
      index = next;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (word) {
      const next = index + word[0].length;
      if (word[0].toLowerCase() === "x" && sql[next] === "'") {
        const [value, afterBlob] = quotedToken(sql, next, "'");
        if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
          throw new Error("unsafe SQL: invalid blob literal");
        }
        tokens.push({ kind: "blob", value });
        index = afterBlob;
      } else {
        tokens.push({ kind: "word", value: word[0] });
        index = next;
      }
      continue;
    }
    if (char === "?" || char === ":" || char === "@" || char === "$") {
      const parameter = /^(?:\?\d*|[:@$][A-Za-z0-9_$:.]*)/.exec(sql.slice(index));
      if (!parameter || parameter[0].length === 1 && char !== "?") {
        throw new Error("unsafe SQL: invalid bind parameter");
      }
      tokens.push({ kind: "parameter", value: parameter[0] });
      index += parameter[0].length;
      continue;
    }
    tokens.push({ kind: "symbol", value: char });
    index += 1;
  }
  return tokens;
}

/** Reject SQL outside the deliberately narrow application query/write subset. */
export function assertSafeSql(sql: string): void {
  if (typeof sql !== "string") throw new Error("unsafe SQL: statement must be a string");
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new Error("unsafe SQL: empty statement");

  const semicolons = tokens.flatMap((token, index) => token.value === ";" ? [index] : []);
  if (
    semicolons.length > 1 ||
    semicolons.length === 1 && semicolons[0] !== tokens.length - 1
  ) {
    throw new Error("unsafe SQL: multiple statements");
  }
  if (semicolons.length === 1) tokens.pop();
  if (tokens.length === 0) throw new Error("unsafe SQL: empty statement");

  const first = tokens[0];
  if (first.kind !== "word" || !FIRST_TOKENS.has(first.value.toLowerCase())) {
    throw new Error("unsafe SQL: forbidden statement type");
  }

  for (const token of tokens) {
    if (token.kind === "word") {
      const folded = token.value.toLowerCase();
      if (FORBIDDEN_WORDS.has(folded)) throw new Error(`unsafe SQL: forbidden token ${token.value}`);
      if (isProtected(token.value)) throw new Error(`unsafe SQL: protected identifier ${token.value}`);
    } else if ((token.kind === "identifier" || token.kind === "string") && isProtected(token.value)) {
      throw new Error("unsafe SQL: protected quoted name");
    }
  }
}

function frozenRow(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("database returned a non-record row");
  }
  return { ...(row as Record<string, unknown>) };
}

/** Build the only ordinary production database surface. Native objects never escape. */
export function createSafeDatabase(resolve: () => Database.Database): SafeDatabase {
  const safe: SafeDatabase = {
    prepare(sql: string): SafeStatement {
      assertSafeSql(sql);
      return Object.freeze({
        run(...bindings: unknown[]): SafeRunResult {
          const result = resolve().prepare(sql).run(...bindings);
          return Object.freeze({
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          });
        },
        get(...bindings: unknown[]): Record<string, unknown> | undefined {
          const row = resolve().prepare(sql).get(...bindings);
          return row === undefined ? undefined : frozenRow(row);
        },
        all(...bindings: unknown[]): Record<string, unknown>[] {
          return resolve().prepare(sql).all(...bindings).map(frozenRow);
        },
      });
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => R): SafeTransaction<A, R> {
      const invoke = (mode: "default" | "deferred" | "immediate" | "exclusive", args: A): R => {
        // better-sqlite3 forwards the transaction function's invocation receiver
        // to the callback. Its mode functions carry a `.database` reference, so
        // neither the native callback nor any mode may be invoked as a method.
        const transaction = resolve().transaction(
          (...callbackArgs: A) => Reflect.apply(fn, undefined, callbackArgs),
        );
        const selected = mode === "default" ? transaction : transaction[mode];
        return Reflect.apply(selected, undefined, args);
      };
      const wrapped = ((...args: A) => invoke("default", args)) as SafeTransaction<A, R>;
      Object.defineProperties(wrapped, {
        deferred: {
          value: Object.freeze((...args: A) => invoke("deferred", args)),
          enumerable: true,
        },
        immediate: {
          value: Object.freeze((...args: A) => invoke("immediate", args)),
          enumerable: true,
        },
        exclusive: {
          value: Object.freeze((...args: A) => invoke("exclusive", args)),
          enumerable: true,
        },
      });
      return Object.freeze(wrapped);
    },
  };
  return Object.freeze(safe);
}
