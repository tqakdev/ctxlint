import { describe, expect, it } from "vitest";
import type { Surface, SurfaceKind } from "../src/core/model.js";
import type { CursorRuleMeta } from "../src/core/parsers/cursorRule.js";
import { parseCursorRule } from "../src/core/parsers/cursorRule.js";
import { extractRules } from "../src/core/parsers/markdown.js";
import { parseSkill } from "../src/core/parsers/skill.js";
import type { WindsurfRuleMeta } from "../src/core/parsers/windsurfRule.js";
import { parseWindsurfRule } from "../src/core/parsers/windsurfRule.js";

function surface(raw: string, kind: SurfaceKind = "agents-md", path = "TEST.md"): Surface {
  return {
    id: "test",
    path,
    kind,
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

describe("lenient frontmatter recovery (Cursor's non-strict-YAML .mdc format)", () => {
  it("recovers unquoted globs Cursor itself writes, without a broken-frontmatter finding", () => {
    const raw = [
      "---",
      "description: TypeScript rules",
      "globs: **/*.ts,**/*.tsx",
      "alwaysApply: false",
      "---",
      "# Rules",
      "",
      "- Use strict mode.",
      "",
    ].join("\n");
    const s = surface(raw, "cursor-rule", ".cursor/rules/ts.mdc");
    const { rules, findings } = parseCursorRule(s);
    expect(findings).toEqual([]);
    const meta = s.meta as CursorRuleMeta;
    expect(meta.frontmatterError).toBeUndefined();
    expect(meta.globs).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(meta.alwaysApply).toBe(false);
    expect(meta.description).toBe("TypeScript rules");
    // Spans still point into the original file (body starts after line 5).
    expect(rules[0]?.span.startLine).toBeGreaterThan(5);
  });

  it("still flags frontmatter that is broken in every format", () => {
    const raw = [
      "---",
      'globs: ["src/**',
      "alwaysApply: yes",
      "--",
      "# Rules",
      "- A rule.",
      "",
    ].join("\n");
    const s = surface(raw, "cursor-rule", ".cursor/rules/broken.mdc");
    const { rules, findings } = parseCursorRule(s);
    expect((s.meta as CursorRuleMeta).frontmatterError).toBeDefined();
    expect(findings.some((f) => f.message.includes("broken frontmatter"))).toBe(true);
    // Body rules are still extracted past the broken block.
    expect(rules.some((r) => r.text.includes("A rule"))).toBe(true);
  });

  it("recovers windsurf trigger/globs written unquoted", () => {
    const raw = [
      "---",
      "trigger: glob",
      "globs: src/**/*.{ts,tsx}",
      "---",
      "- Keep components pure.",
      "",
    ].join("\n");
    const s = surface(raw, "windsurf-rule", ".windsurf/rules/web.md");
    const { findings } = parseWindsurfRule(s);
    expect(findings).toEqual([]);
    const meta = s.meta as WindsurfRuleMeta;
    expect(meta.trigger).toBe("glob");
    expect(meta.globs).toEqual(["src/**/*.{ts,tsx}"]);
  });

  it("keeps SKILL.md strict — its format IS YAML, so failures stay findings", () => {
    const raw = ["---", "name: *broken", "---", "- Do the thing.", ""].join("\n");
    const s = surface(raw, "skill", ".claude/skills/x/SKILL.md");
    const { findings } = parseSkill(s);
    expect(findings.some((f) => f.message.includes("broken frontmatter"))).toBe(true);
  });
});
