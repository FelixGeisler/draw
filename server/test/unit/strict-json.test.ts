import { describe, expect, it } from "vitest";
// The production contract is intentionally a plain Node ESM module.
// @ts-expect-error JavaScript module has no declaration file.
import { parseStrictJson, StrictJsonError } from "../../../scripts/lib/strict-json.mjs";
import { bytes } from "./oci-validator-fixtures.js";

function caught(input: unknown): StrictJsonError {
  try {
    parseStrictJson(input);
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    expect((error as Error).name).toBe("StrictJsonError");
    return error as StrictJsonError;
  }
  throw new Error("expected parseStrictJson to fail");
}

function withArrayMethodPollution<T>(
  name: "push" | "pop",
  replacement: (...args: any[]) => unknown,
  call: () => T,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name);
  if (!descriptor) throw new Error(`Array.prototype.${name} is unavailable`);
  const polluted = Object.create(null);
  polluted.value = replacement;
  polluted.enumerable = descriptor.enumerable;
  polluted.configurable = descriptor.configurable;
  polluted.writable = descriptor.writable;
  Object.defineProperty(Array.prototype, name, polluted);
  try {
    return call();
  } finally {
    Object.defineProperty(Array.prototype, name, descriptor);
  }
}

describe("parseStrictJson contract", () => {
  it("exports exactly the parser and typed error", async () => {
    // @ts-expect-error JavaScript module has no declaration file.
    const module = await import("../../../scripts/lib/strict-json.mjs");
    expect(Object.keys(module).sort()).toEqual(["StrictJsonError", "parseStrictJson"]);
    expect(Object.getPrototypeOf(StrictJsonError.prototype)).toBe(Error.prototype);
  });

  it("parses one normal nested JSON value with JSON number and escape semantics", () => {
    const value = parseStrictJson(bytes('{"text":"line\\n😀","values":[null,true,false,-12.5e2],"nested":{"ok":1}}'));
    expect(value).toEqual({ text: "line\n😀", values: [null, true, false, -1250], nested: { ok: 1 } });
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value.nested)).toBeNull();
  });

  it("rejects invalid input, malformed UTF-8, a leading BOM, syntax, and trailing content with exact codes", () => {
    expect(caught("{}").code).toBe("INVALID_INPUT");
    expect(caught(new Uint8Array([0xc3, 0x28])).code).toBe("INVALID_UTF8");
    expect(caught(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).code).toBe("BOM_FORBIDDEN");
    for (const source of ["", "{", "[1,]", '{"a":}', '"\\x"', "01"]) {
      const expected = source === "01" ? "TRAILING_CONTENT" : "JSON_SYNTAX";
      expect(caught(bytes(source)).code).toBe(expected);
    }
    for (const source of ["{}{}", "true x", "[]\u00a0"]) {
      expect(caught(bytes(source)).code).toBe("TRAILING_CONTENT");
    }
  });

  it("parses and rejects deeply nested bounded JSON without using the JavaScript call stack", () => {
    const depth = 10_000;
    const validSource = "[".repeat(depth) + "0" + "]".repeat(depth);
    expect(bytes(validSource).byteLength).toBeLessThan(1024 * 1024);

    let value = parseStrictJson(bytes(validSource));
    for (let level = 0; level < depth; level += 1) {
      expect(Array.isArray(value)).toBe(true);
      value = value[0];
    }
    expect(value).toBe(0);

    const error = caught(bytes("[".repeat(depth)));
    expect(error.code).toBe("JSON_SYNTAX");
  });

  it("rejects identical, conflicting, nested, and escape-equivalent duplicate decoded names", () => {
    for (const source of [
      '{"a":1,"a":1}',
      '{"a":1,"a":2}',
      '{"outer":{"x":1,"x":2}}',
      '{"a":1,"\\u0061":2}',
      '{"😀":1,"\\ud83d\\ude00":2}',
    ]) {
      expect(caught(bytes(source)).code).toBe("DUPLICATE_KEY");
    }
  });

  it("preserves dangerous-looking names as own data at every null-prototype object level", () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const value = parseStrictJson(bytes(
      '{"__proto__":{"__proto__":"n1","constructor":"n2","prototype":"n3"},' +
      '"constructor":{"__proto__":"c1","constructor":"c2","prototype":"c3"},' +
      '"prototype":{"__proto__":"p1","constructor":"p2","prototype":"p3"}}',
    ));

    expect(Object.getPrototypeOf(value)).toBeNull();
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(value, name)).toBe(true);
      expect(Object.getPrototypeOf(value[name])).toBeNull();
      expect(Object.keys(value[name]).sort()).toEqual(["__proto__", "constructor", "prototype"].sort());
    }
    expect(value.__proto__.constructor).toBe("n2");
    expect(value.constructor.__proto__).toBe("c1");
    expect(value.prototype.prototype).toBe("p3");
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });

  it("defines members without invoking inherited setters", () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, "strictJsonSetterProbe", {
      configurable: true,
      set() { calls += 1; },
    });
    try {
      const value = parseStrictJson(bytes('{"strictJsonSetterProbe":1,"child":{"strictJsonSetterProbe":2}}'));
      expect(calls).toBe(0);
      expect(value.strictJsonSetterProbe).toBe(1);
      expect(value.child.strictJsonSetterProbe).toBe(2);
    } finally {
      delete (Object.prototype as Record<string, unknown>).strictJsonSetterProbe;
    }
  });

  it("constructs parsed arrays without inherited push or pop", () => {
    const parsed = withArrayMethodPollution(
      "push",
      function pollutedPush(this: unknown[], ...items: unknown[]) {
        for (let index = 0; index < items.length; index += 1) {
          const descriptor = Object.create(null);
          descriptor.value = typeof items[index] === "number" ? 999 : items[index];
          descriptor.enumerable = true;
          descriptor.configurable = true;
          descriptor.writable = true;
          Reflect.defineProperty(this, String(this.length), descriptor);
        }
        return this.length;
      },
      () => parseStrictJson(bytes('{"values":[1,{"nested":[2]}]}')),
    );
    expect(parsed).toEqual({ values: [1, { nested: [2] }] });

    const empty = withArrayMethodPollution(
      "pop",
      () => { throw new Error("polluted pop must not run"); },
      () => parseStrictJson(bytes("[]")),
    );
    expect(empty).toEqual([]);
  });
});
