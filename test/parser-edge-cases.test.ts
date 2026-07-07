import { describe, expect, it } from "vitest";
import type { Surface } from "../src/core/model.js";
import { extractRules } from "../src/core/parsers/markdown.js";

function surface(raw: string): Surface {
  return {
    id: "test",
    path: "TEST.md",
    kind: "agents-md",
    scope: "repo-root",
    tools: [],
    raw,
    tokensEstimated: 0,
  };
}

describe("markdown parser edge cases (audit regressions)", () => {
  it("handles heading hierarchy gaps (h1 -> h3) without undefined section entries", () => {
    const rules = extractRules(surface("# H1\n\n### H3\n\n- A rule under the gap.\n"));
    expect(rules).toHaveLength(1);
    const section = rules[0]?.section ?? [];
    expect(section).toEqual(["H1", "", "H3"]);
    for (const entry of section) expect(typeof entry).toBe("string");
    // Serialization must not produce null holes.
    expect(JSON.stringify(section)).toBe('["H1","","H3"]');
  });

  it("handles an empty heading without crashing and resets deeper levels", () => {
    const rules = extractRules(surface("# Top\n\n## Sub\n\n#\n\n- Rule after bare heading.\n"));
    expect(rules).toHaveLength(1);
    // The bare `#` is an h1: deeper levels reset, its own text is empty.
    expect(rules[0]?.section).toEqual([""]);
  });

  it("survives pathological nesting quickly instead of walking 500 levels", () => {
    let doc = "# Deep\n\n";
    // 500-deep blockquote nesting: "> > > > … text"
    doc += `${"> ".repeat(500)}buried text\n`;
    const start = performance.now();
    expect(() => extractRules(surface(doc))).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("keeps normal section tracking intact", () => {
    const rules = extractRules(
      surface("# A\n\n## B\n\n- one\n\n## C\n\n- two\n\n# D\n\n- three\n"),
    );
    expect(rules.map((r) => r.section)).toEqual([["A", "B"], ["A", "C"], ["D"]]);
  });
});
