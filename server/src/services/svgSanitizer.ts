/**
 * Allowlist-based SVG sanitizer for model-generated card art (#27, ADR-22).
 *
 * Strategy: never emit any slice of the input. The input is tokenized and a
 * NEW document is serialized from scratch — only allowlisted element names,
 * only allowlisted attribute names, values validated and re-escaped. Anything
 * unknown (elements with their whole subtree, attributes, text nodes,
 * comments, CDATA, DOCTYPE/entity declarations, processing instructions) is
 * dropped, so parser-differential tricks in the input cannot survive into the
 * output. Sanitization runs BEFORE storage; the client additionally renders
 * only via <img src="data:image/svg+xml,...">, which never executes scripts —
 * two independent layers (never dangerouslySetInnerHTML).
 *
 * Pure module: no DB, no HTTP, no SDK — unit-testable in isolation.
 */

// Case-sensitive, like the SVG (XML) parser that will consume the output.
// <SCRIPT>/<ForeignObject> etc. simply fail the lookup and are dropped.
// Deliberately excluded: script, foreignObject, style, a, image/feImage
// (external or data: references), text/tspan/textPath (card art carries no
// text), animate*/set (unneeded), and everything HTML.
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
]);

// One global attribute allowlist instead of a per-element table: every name
// here is inert on any element, so the cross product cannot open a hole.
// on* handlers are absent by construction; href is value-checked below.
const ALLOWED_ATTRS = new Set([
  "id",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "d",
  "points",
  "pathLength",
  "transform",
  "gradientTransform",
  "patternTransform",
  "gradientUnits",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "filterUnits",
  "primitiveUnits",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "flood-color",
  "flood-opacity",
  "lighting-color",
  "color-interpolation-filters",
  "stdDeviation",
  "in",
  "in2",
  "result",
  "mode",
  "type",
  "values",
  "tableValues",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
  "baseFrequency",
  "numOctaves",
  "seed",
  "stitchTiles",
  "scale",
  "xChannelSelector",
  "yChannelSelector",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "dx",
  "dy",
  "radius",
  "order",
  "kernelMatrix",
  "divisor",
  "bias",
  "targetX",
  "targetY",
  "edgeMode",
  "surfaceScale",
  "diffuseConstant",
  "specularConstant",
  "specularExponent",
  "azimuth",
  "elevation",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "limitingConeAngle",
  "z",
  "href", // value-restricted to same-document "#id" references
  "style", // value-restricted: no url() outside the document, no escapes/entities
  "vector-effect",
  "shape-rendering",
  "paint-order",
  "display",
  "visibility",
  "overflow",
]);

// Values in quotes may contain '>' — the quoted alternatives keep the tag
// regex from ending early. Unquoted values exclude '/' so a trailing
// self-closing slash is never swallowed into a value. Attribute names and
// unquoted values also exclude '<': otherwise a malformed unclosed-tag run
// ("<a <a <a …") is greedily swallowed to end-of-input before the match
// fails, and rescanning from each '<' turns the main loop quadratic —
// seconds of synchronous CPU on kilobytes of input. Stopping a match at the
// next '<' keeps every attempt short and the whole scan linear.
const TAG_OPEN_RE =
  /^<([A-Za-z][A-Za-z0-9:_-]*)((?:\s+[^\s=/><]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/<]*))?)*)\s*(\/)?>/;
const TAG_CLOSE_RE = /^<\/\s*([A-Za-z][A-Za-z0-9:_-]*)\s*>/;
const ATTR_RE = /([^\s=/><]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/<]*)))?/g;

// Same-document reference only: "#id". Entity-obfuscated schemes
// ("&#106;avascript:...") fail this by construction — entities are never
// decoded here, and the value would not start with '#'.
const FRAGMENT_HREF_RE = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;

// Card art is generated with an 8K max_tokens cap (#113; ~32 KB of text), so
// 64 KB is still generous. The guard exists to bound CPU before the scan
// starts — it must stay within the same order of magnitude as a real
// generation, and gets reviewed whenever CARD_ART_MAX_TOKENS moves.
const MAX_INPUT_LENGTH = 64_000;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Every url(...) in the value must be a same-document fragment reference,
 * url(#id) — external, data:, and entity/escape-obfuscated targets fail.
 * Values containing a backslash are rejected outright: CSS escapes can
 * smuggle "url(" past pattern checks (e.g. "u\72 l(http://…)").
 */
function urlsAreSafe(value: string): boolean {
  if (value.includes("\\")) return false;
  const calls = value.match(/url\s*\(/gi)?.length ?? 0;
  if (calls === 0) return true;
  const safe = value.match(/url\(#[A-Za-z_][A-Za-z0-9_.-]*\)/g)?.length ?? 0;
  return calls === safe;
}

function safeStyleValue(value: string): boolean {
  // No escapes, at-rules (@import), entities (&#...), nested markup, external
  // protocols, or IE-era dynamic values. Fragment url(#id) fills stay allowed.
  if (/[\\@<&]|expression|javascript|https?:|image-set/i.test(value)) return false;
  return urlsAreSafe(value);
}

interface Attr {
  name: string;
  value: string;
}

function filterAttrs(rawAttrText: string, isRoot: boolean): Attr[] {
  const attrs: Attr[] = [];
  const seen = new Set<string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(rawAttrText)) !== null) {
    let name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (/^on/i.test(name)) continue; // event handlers, any casing
    if (name === "xlink:href") name = "href"; // modern SVG; same value rules
    // xmlns* from the input is dropped; the canonical one is re-added below.
    if (!ALLOWED_ATTRS.has(name)) continue;
    if (seen.has(name)) continue;
    if (name === "href") {
      if (!FRAGMENT_HREF_RE.test(value)) continue;
    } else if (name === "style") {
      if (!safeStyleValue(value)) continue;
    } else {
      // Belt and braces — no allowlisted attribute legitimately carries a
      // scheme, and url() may only point into the document itself.
      if (/javascript:|data:/i.test(value)) continue;
      if (!urlsAreSafe(value)) continue;
    }
    seen.add(name);
    attrs.push({ name, value });
  }
  if (isRoot) attrs.push({ name: "xmlns", value: "http://www.w3.org/2000/svg" });
  return attrs;
}

/**
 * Returns the sanitized, re-serialized SVG document, or null when the input
 * has no usable <svg> root or nothing drawable survived filtering (callers
 * treat null as "generation failed" and do not cache).
 */
export function sanitizeSvg(input: string): string | null {
  if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) return null;
  const start = input.indexOf("<svg");
  if (start === -1) return null;

  const out: string[] = [];
  const openStack: string[] = [];
  // Depth inside a disallowed element: its entire subtree is dropped, so a
  // <script> body or <foreignObject> payload never contributes anything.
  let skip = 0;
  let rootClosed = false;
  let i = start;

  while (i < input.length && !rootClosed) {
    const lt = input.indexOf("<", i);
    if (lt === -1) break;
    i = lt; // text between tags is never emitted
    const rest = input.slice(i);

    if (rest.startsWith("<!--")) {
      const end = input.indexOf("-->", i + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (rest.startsWith("<![CDATA[")) {
      const end = input.indexOf("]]>", i + 9);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (rest.startsWith("<!")) {
      // DOCTYPE/entity declarations. A '>' inside an internal subset ends the
      // skip early — the remainder is then plain text, which is dropped anyway.
      const end = input.indexOf(">", i + 2);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (rest.startsWith("<?")) {
      const end = input.indexOf("?>", i + 2);
      i = end === -1 ? input.length : end + 2;
      continue;
    }

    const close = TAG_CLOSE_RE.exec(rest);
    if (close) {
      i += close[0].length;
      if (skip > 0) {
        skip--;
        continue;
      }
      const idx = openStack.lastIndexOf(close[1]);
      if (idx !== -1) {
        // Close intermediate unclosed elements too, keeping output well-formed.
        while (openStack.length > idx) out.push(`</${openStack.pop()!}>`);
        if (openStack.length === 0) rootClosed = true;
      }
      continue;
    }

    const open = TAG_OPEN_RE.exec(rest);
    if (!open) {
      i += 1; // stray '<' — treated as text, dropped
      continue;
    }
    i += open[0].length;
    const name = open[1];
    const selfClosing = open[3] === "/";

    if (skip > 0) {
      if (!selfClosing) skip++;
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      if (!selfClosing) skip = 1;
      continue;
    }

    const attrs = filterAttrs(open[2] ?? "", openStack.length === 0);
    const attrText = attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
    if (selfClosing) {
      out.push(`<${name}${attrText}/>`);
    } else {
      out.push(`<${name}${attrText}>`);
      openStack.push(name);
    }
  }

  while (openStack.length > 0) out.push(`</${openStack.pop()!}>`);

  const result = out.join("");
  if (!result.startsWith("<svg")) return null;
  // An svg whose visible content was entirely filtered away is not art.
  if (!/<(path|rect|circle|ellipse|line|polyline|polygon)[\s/>]/.test(result)) return null;
  return result;
}
