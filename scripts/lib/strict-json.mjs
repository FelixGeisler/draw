export class StrictJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

const JSON_WHITESPACE = new Set(["\u0009", "\u000a", "\u000d", "\u0020"]);
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

function syntax(message) {
  throw new StrictJsonError("JSON_SYNTAX", message);
}

class Parser {
  constructor(text) {
    this.text = text;
    this.position = 0;
  }

  parse() {
    this.skipWhitespace();
    if (this.position === this.text.length) syntax("JSON text is empty");

    const root = this.parseValueToken();
    const stack = root.frame ? [root.frame] : [];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      this.skipWhitespace();

      if (frame.type === "array") {
        if (frame.state === "value-or-end" && this.text[this.position] === "]") {
          this.position += 1;
          stack.pop();
          continue;
        }
        if (frame.state === "comma-or-end") {
          const separator = this.text[this.position];
          if (separator === "]") {
            this.position += 1;
            stack.pop();
            continue;
          }
          if (separator !== ",") syntax("Expected ',' or ']' in JSON array");
          this.position += 1;
          this.skipWhitespace();
          frame.state = "value";
        }

        const item = this.parseValueToken();
        frame.value.push(item.value);
        frame.state = "comma-or-end";
        if (item.frame) stack.push(item.frame);
        continue;
      }

      if (frame.state === "key-or-end" && this.text[this.position] === "}") {
        this.position += 1;
        stack.pop();
        continue;
      }
      if (frame.state === "comma-or-end") {
        const separator = this.text[this.position];
        if (separator === "}") {
          this.position += 1;
          stack.pop();
          continue;
        }
        if (separator !== ",") syntax("Expected ',' or '}' in JSON object");
        this.position += 1;
        this.skipWhitespace();
      }

      if (this.text[this.position] !== '"') syntax("Expected a JSON object member name");
      const name = this.parseString();
      if (frame.names.has(name)) {
        throw new StrictJsonError("DUPLICATE_KEY", `Duplicate JSON member: ${name}`);
      }
      frame.names.add(name);
      this.skipWhitespace();
      if (this.text[this.position] !== ":") syntax("Expected ':' after JSON member name");
      this.position += 1;
      this.skipWhitespace();

      const member = this.parseValueToken();
      Object.defineProperty(frame.value, name, {
        value: member.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      frame.state = "comma-or-end";
      if (member.frame) stack.push(member.frame);
    }

    this.skipWhitespace();
    if (this.position !== this.text.length) {
      throw new StrictJsonError("TRAILING_CONTENT", "JSON text has trailing content");
    }
    return root.value;
  }

  skipWhitespace() {
    while (JSON_WHITESPACE.has(this.text[this.position])) this.position += 1;
  }

  parseValueToken() {
    const char = this.text[this.position];
    if (char === '"') return { value: this.parseString() };
    if (char === "{") {
      this.position += 1;
      const value = Object.create(null);
      return { value, frame: { type: "object", value, names: new Set(), state: "key-or-end" } };
    }
    if (char === "[") {
      this.position += 1;
      const value = [];
      return { value, frame: { type: "array", value, state: "value-or-end" } };
    }
    if (char === "t") return { value: this.parseLiteral("true", true) };
    if (char === "f") return { value: this.parseLiteral("false", false) };
    if (char === "n") return { value: this.parseLiteral("null", null) };
    if (char === "-" || (char >= "0" && char <= "9")) return { value: this.parseNumber() };
    syntax("Expected a JSON value");
  }

  parseLiteral(token, value) {
    if (this.text.slice(this.position, this.position + token.length) !== token) {
      syntax(`Invalid ${token} literal`);
    }
    this.position += token.length;
    return value;
  }

  parseNumber() {
    const match = NUMBER.exec(this.text.slice(this.position));
    if (!match) syntax("Invalid JSON number");
    this.position += match[0].length;
    return JSON.parse(match[0]);
  }

  parseString() {
    const start = this.position;
    this.position += 1;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      if (char === '"') {
        this.position += 1;
        try {
          return JSON.parse(this.text.slice(start, this.position));
        } catch {
          syntax("Invalid JSON string");
        }
      }
      if (char === "\\") {
        this.position += 1;
        if (this.position >= this.text.length) syntax("Unterminated JSON escape");
        const escape = this.text[this.position];
        if (escape === "u") {
          const quad = this.text.slice(this.position + 1, this.position + 5);
          if (!HEX_QUAD.test(quad)) syntax("Invalid Unicode escape");
          this.position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) syntax("Invalid JSON escape");
        this.position += 1;
        continue;
      }
      if (char.charCodeAt(0) <= 0x1f) syntax("Unescaped control character in JSON string");
      this.position += 1;
    }
    syntax("Unterminated JSON string");
  }

}

export function parseStrictJson(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new StrictJsonError("INVALID_INPUT", "bytes must be a Uint8Array");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("INVALID_UTF8", "bytes are not valid UTF-8");
  }

  if (text.startsWith("\ufeff")) {
    throw new StrictJsonError("BOM_FORBIDDEN", "a leading UTF-8 BOM is forbidden");
  }
  try {
    return new Parser(text).parse();
  } catch (error) {
    if (error instanceof StrictJsonError) throw error;
    throw new StrictJsonError("JSON_SYNTAX", "JSON text could not be parsed");
  }
}
