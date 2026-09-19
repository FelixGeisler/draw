import { describe, expect, it } from "vitest";
import { PushResolutionError, resolvePushEndpoint, type IsolatedResolver } from "../../src/push/resolver.js";

function error(code: string) { return Object.assign(new Error(code), { code }); }

class FakeResolver implements IsolatedResolver {
  calls: string[] = [];
  cancelled = false;
  private rejects: ((reason: unknown) => void)[] = [];
  constructor(private readonly answers?: { a?: string[]; aaaa?: string[]; aError?: string; aaaaError?: string }) {}
  resolve4(_host: string, options: { ttl: false }): Promise<string[]> {
    this.calls.push(`A:${options.ttl}`);
    if (this.answers) return this.answers.aError ? Promise.reject(error(this.answers.aError)) : Promise.resolve(this.answers.a ?? []);
    return new Promise((_resolve, reject) => this.rejects.push(reject));
  }
  resolve6(_host: string, options: { ttl: false }): Promise<string[]> {
    this.calls.push(`AAAA:${options.ttl}`);
    if (this.answers) return this.answers.aaaaError ? Promise.reject(error(this.answers.aaaaError)) : Promise.resolve(this.answers.aaaa ?? []);
    return new Promise((_resolve, reject) => this.rejects.push(reject));
  }
  cancel(): void {
    this.cancelled = true;
    for (const reject of this.rejects.splice(0)) reject(error("ECANCELLED"));
  }
}

describe("isolated Push endpoint resolution", () => {
  it("starts exactly A+AAAA, tolerates ordinary no-data for one family, and keeps resolver order", async () => {
    const resolver = new FakeResolver({ a: ["8.8.8.8", "1.1.1.1"], aaaaError: "ENODATA" });
    await expect(resolvePushEndpoint("push.example", () => resolver)).resolves.toBe("8.8.8.8");
    expect(resolver.calls).toEqual(["A:false", "AAAA:false"]);
    expect(resolver.cancelled).toBe(false);
  });

  it("fails total no-answer, resolver errors, and complete mixed sets without detail", async () => {
    for (const answers of [
      { aError: "ENODATA", aaaaError: "ENOTFOUND" },
      { a: ["8.8.8.8"], aaaaError: "ESERVFAIL" },
      { a: ["8.8.8.8", "10.0.0.1"], aaaa: [] },
    ]) {
      await expect(resolvePushEndpoint("push.example", () => new FakeResolver(answers))).rejects.toMatchObject({ kind: "unavailable" });
    }
  });

  it("cancels its own resolver on deadline and waits for both operations to settle", async () => {
    const resolver = new FakeResolver();
    const result = resolvePushEndpoint("push.example", () => resolver, undefined, 5);
    await expect(result).rejects.toEqual(new PushResolutionError("timeout"));
    expect(resolver.cancelled).toBe(true);
    expect(resolver.calls).toEqual(["A:false", "AAAA:false"]);
  });

  it("cancels and settles on inbound abort", async () => {
    const resolver = new FakeResolver();
    const abort = new AbortController();
    const result = resolvePushEndpoint("push.example", () => resolver, abort.signal, 10_000);
    abort.abort();
    await expect(result).rejects.toMatchObject({ kind: "aborted" });
    expect(resolver.cancelled).toBe(true);
  });
});
