import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/services/svgSanitizer.js";

// The sanitizer is the security boundary between model output and the user's
// browser (#27): everything it emits ends up in an <img src="data:..."> on
// the DrawPage and is stored verbatim in card_art. These tests are written
// adversarially — each case is an actual smuggling technique, not a happy
// path with one bad tag.

// Every valid artwork needs at least one visible shape, so helpers include one.
const BASE_RECT = '<rect width="300" height="420" fill="#1b1e27"/>';
const wrap = (inner: string, rootAttrs = "") =>
  `<svg viewBox="0 0 300 420"${rootAttrs}>${inner}${BASE_RECT}</svg>`;

describe("benign card art passes through", () => {
  it("keeps shapes, gradients, transforms and presentation attributes", () => {
    const svg = wrap(
      `<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="#232735"/><stop offset="1" stop-color="#4f8cff" stop-opacity="0.6"/>` +
        `</linearGradient></defs>` +
        `<circle cx="150" cy="210" r="80" fill="url(#g1)" opacity="0.8"/>` +
        `<path d="M0 420 C 100 300, 200 300, 300 420" stroke="#4f8cff" stroke-width="2" fill="none"/>` +
        `<g transform="rotate(15 150 210)"><ellipse cx="150" cy="100" rx="40" ry="12" fill="#232735"/></g>`,
    );
    const out = sanitizeSvg(svg);
    expect(out).toBeTruthy();
    expect(out).toContain("<linearGradient");
    expect(out).toContain('fill="url(#g1)"');
    expect(out).toContain('d="M0 420 C 100 300, 200 300, 300 420"');
    expect(out).toContain('transform="rotate(15 150 210)"');
    expect(out).toContain('viewBox="0 0 300 420"');
  });

  it("keeps filter primitives (turbulence + blur) and same-document filter refs", () => {
    const svg = wrap(
      `<filter id="f1"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/>` +
        `<feGaussianBlur stdDeviation="1.5"/></filter>` +
        `<rect x="0" y="0" width="300" height="420" fill="#232735" filter="url(#f1)"/>`,
    );
    const out = sanitizeSvg(svg);
    expect(out).toContain("<feTurbulence");
    expect(out).toContain('filter="url(#f1)"');
  });

  it("keeps a fragment href on <use> and normalizes xlink:href to href", () => {
    const out = sanitizeSvg(
      wrap(`<defs><circle id="dot" r="3" fill="#4f8cff"/></defs><use href="#dot" x="20"/><use xlink:href="#dot" x="40"/>`),
    );
    expect(out).toContain('href="#dot"');
    expect(out).not.toContain("xlink");
  });

  it("stamps the canonical SVG namespace on the root", () => {
    const out = sanitizeSvg(`<svg viewBox="0 0 300 420">${BASE_RECT}</svg>`);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    // input-supplied namespaces are dropped, not echoed
    const spoofed = sanitizeSvg(wrap("", ' xmlns="http://evil.example/ns"'));
    expect(spoofed).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(spoofed).not.toContain("evil.example");
  });

  it("closes unclosed elements so the output stays well-formed", () => {
    const out = sanitizeSvg(`<svg viewBox="0 0 300 420"><g><rect width="300" height="420"/>`);
    expect(out).toBe(
      '<svg viewBox="0 0 300 420" xmlns="http://www.w3.org/2000/svg"><g><rect width="300" height="420"/></g></svg>',
    );
  });
});

describe("script execution vectors", () => {
  it("drops <script> including its body", () => {
    const out = sanitizeSvg(wrap(`<script>fetch("https://evil.example/x")</script>`));
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/script|fetch|evil/i);
  });

  it("drops <script> regardless of tag casing (XML is case-sensitive, allowlist is too)", () => {
    const out = sanitizeSvg(wrap(`<SCRIPT>alert(1)</SCRIPT><ScRiPt href="x">alert(2)</ScRiPt>`));
    expect(out).not.toMatch(/script|alert/i);
  });

  it("drops <foreignObject> and its entire HTML payload", () => {
    // The unbalanced HTML void tag (<img> without a close) desynchronizes the
    // subtree skip, which only ever errs toward dropping MORE — here the whole
    // document collapses to null. Both outcomes are safe; neither may leak.
    const out =
      sanitizeSvg(
        wrap(
          `<foreignObject width="300" height="420"><body xmlns="http://www.w3.org/1999/xhtml">` +
            `<iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)"></body></foreignObject>`,
        ),
      ) ?? "";
    expect(out).not.toMatch(/foreignObject|iframe|onerror|evil/i);
  });

  it("drops a balanced <foreignObject> subtree while keeping the surrounding art", () => {
    const out = sanitizeSvg(
      wrap(
        `<foreignObject width="300" height="420"><div><span>payload</span></div></foreignObject>` +
          `<circle cx="150" cy="210" r="40" fill="#232735"/>`,
      ),
    );
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/foreignObject|div|span|payload/i);
    expect(out).toContain("<circle");
  });

  it("drops every on* event handler, any casing and spacing", () => {
    const out = sanitizeSvg(
      `<svg viewBox="0 0 300 420" onload="alert(1)">` +
        `<rect width="300" height="420" onclick="alert(2)" ONMouseOver = "alert(3)" fill="#1b1e27"/></svg>`,
    );
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/onload|onclick|onmouseover|alert/i);
    expect(out).toContain('fill="#1b1e27"'); // the benign attribute survives
  });

  it("drops nested content of a disallowed element with the element (no orphan re-parenting)", () => {
    // If <a>'s children were kept, the rect would be re-parented into the
    // document while its malicious wrapper silently vanished.
    const out = sanitizeSvg(wrap(`<a href="https://evil.example"><rect width="10" height="10" fill="red"/></a>`));
    expect(out).not.toContain('fill="red"');
    expect(out).not.toContain("evil");
  });
});

describe("external and pseudo-protocol references", () => {
  it("drops javascript: hrefs on <use>", () => {
    const out = sanitizeSvg(wrap(`<use href="javascript:alert(1)"/>`));
    expect(out).not.toMatch(/javascript|alert/i);
  });

  it("drops entity-obfuscated javascript: hrefs (entities are never decoded)", () => {
    const out = sanitizeSvg(wrap(`<use href="&#106;avascript:alert(1)"/>`));
    expect(out).not.toMatch(/avascript|alert/i);
  });

  it("drops external hrefs — http, https, protocol-relative and xlink alike", () => {
    const out = sanitizeSvg(
      wrap(
        `<use href="http://evil.example/a.svg#x"/><use href="https://evil.example/b.svg#y"/>` +
          `<use href="//evil.example/c.svg#z"/><use xlink:href="https://evil.example/d.svg#w"/>`,
      ),
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("href");
  });

  it("drops data: hrefs (nested SVG payloads)", () => {
    const out = sanitizeSvg(
      wrap(`<use href="data:image/svg+xml,<svg onload='alert(1)'></svg>"/>`),
    );
    expect(out).not.toMatch(/data:|onload|alert/i);
  });

  it("drops <image> elements entirely — external, data: or otherwise", () => {
    const out = sanitizeSvg(
      wrap(`<image href="https://evil.example/x.png"/><image href="data:image/png;base64,AAAA"/>`),
    );
    expect(out).not.toMatch(/image|evil|base64/i);
  });

  it("drops url() references that leave the document, keeps url(#fragment)", () => {
    const out = sanitizeSvg(
      wrap(
        `<rect width="10" height="10" fill="url(http://evil.example/f.svg#p)"/>` +
          `<rect width="10" height="10" fill="url('https://evil.example/g)"/>` +
          `<rect width="10" height="10" fill="url(data:image/svg+xml,x)"/>` +
          `<rect width="10" height="10" fill="url(#safe)"/>`,
      ),
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/data:/i);
    expect(out).toContain('fill="url(#safe)"');
  });
});

describe("CSS-based vectors", () => {
  it("drops <style> elements with @import and external url()", () => {
    const out = sanitizeSvg(
      wrap(`<style>@import url("https://evil.example/x.css"); rect { fill: url(https://evil.example/p) }</style>`),
    );
    expect(out).not.toMatch(/style|import|evil/i);
  });

  it("keeps a benign style attribute but drops one with an external url()", () => {
    const out = sanitizeSvg(
      wrap(
        `<rect width="10" height="10" style="fill:#232735;opacity:0.5"/>` +
          `<circle r="5" style="fill:url(https://evil.example/p)"/>`,
      ),
    );
    expect(out).toContain('style="fill:#232735;opacity:0.5"');
    expect(out).not.toContain("evil.example");
  });

  it("drops style attributes with entity-obfuscated url targets", () => {
    const out = sanitizeSvg(
      wrap(`<rect width="10" height="10" style="fill:url(&#104;ttp://evil.example)"/>`),
    );
    expect(out).not.toContain("style");
    expect(out).not.toContain("evil.example");
  });

  it("drops style attributes using CSS escapes to smuggle url(", () => {
    const out = sanitizeSvg(
      wrap(String.raw`<rect width="10" height="10" style="background:u\72 l(https://evil.example)"/>`),
    );
    expect(out).not.toContain("style");
    expect(out).not.toContain("evil.example");
  });

  it("keeps style attributes with same-document url(#id) references", () => {
    const out = sanitizeSvg(wrap(`<rect width="10" height="10" style="fill:url(#g1)"/>`));
    expect(out).toContain('style="fill:url(#g1)"');
  });
});

describe("structural smuggling", () => {
  it("drops DOCTYPE and entity declarations without leaking their content", () => {
    const out = sanitizeSvg(
      `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
        `<svg viewBox="0 0 300 420">&xxe;${BASE_RECT}</svg>`,
    );
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/ENTITY|passwd|&xxe;/);
  });

  it("drops comments and CDATA sections including markup hidden inside them", () => {
    const out = sanitizeSvg(
      wrap(`<!-- <script>alert(1)</script> --><![CDATA[<script>alert(2)</script>]]>`),
    );
    expect(out).not.toMatch(/script|alert/i);
  });

  it("drops raw text nodes — card art carries no text at all", () => {
    const out = sanitizeSvg(wrap(`some stray text<g>more text</g>`));
    expect(out).not.toContain("stray");
    expect(out).not.toContain("more text");
  });

  it("escapes attribute values so they cannot break out of the attribute", () => {
    // A misparsed value must not be able to open a new tag on serialization.
    const out = sanitizeSvg(wrap(`<rect width="10" height="10" fill='a"><script>alert(1)</script>'/>`));
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/<script/i);
  });

  it("ignores content after the root </svg> closes", () => {
    const out = sanitizeSvg(
      `<svg viewBox="0 0 300 420">${BASE_RECT}</svg><script>alert(1)</script>`,
    );
    expect(out).not.toMatch(/script|alert/i);
  });
});

describe("rejection of unusable input", () => {
  it("returns null when there is no <svg> root", () => {
    expect(sanitizeSvg("")).toBeNull();
    expect(sanitizeSvg("just prose, no markup")).toBeNull();
    expect(sanitizeSvg("<div><p>html</p></div>")).toBeNull();
  });

  it("returns null when nothing drawable survives filtering", () => {
    expect(sanitizeSvg(`<svg viewBox="0 0 300 420"><script>alert(1)</script></svg>`)).toBeNull();
    expect(sanitizeSvg(`<svg viewBox="0 0 300 420"></svg>`)).toBeNull();
  });

  it("returns null for absurdly large inputs instead of scanning them", () => {
    const huge = `<svg>${"<rect/>".repeat(100_000)}</svg>`;
    expect(sanitizeSvg(huge)).toBeNull();
  });
});
