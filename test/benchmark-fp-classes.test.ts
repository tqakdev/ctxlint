import { describe, expect, it } from "vitest";
import { analyzeStaleness, type RepoFacts } from "../src/core/analyzers/staleness.js";
import { analyzeStructure } from "../src/core/analyzers/structure.js";
import type { Surface } from "../src/core/model.js";
import { extractRules } from "../src/core/parsers/markdown.js";

function surfaceOf(overrides: Partial<Surface> & { raw: string }): Surface {
  return {
    id: "s1",
    path: "AGENTS.md",
    kind: "agents-md",
    scope: "repo-root",
    tools: [],
    tokensEstimated: 0,
    ...overrides,
  };
}

function facts(files: string[], dirs: string[]): RepoFacts {
  return {
    files,
    fileSet: new Set(files),
    dirSet: new Set(dirs),
    scriptsByDir: new Map(),
    truncated: false,
  };
}

function stalenessOf(raw: string, files: string[], dirs: string[]) {
  const surface = surfaceOf({ raw });
  return analyzeStaleness(extractRules(surface), new Map([["s1", surface]]), facts(files, dirs));
}

// False-positive classes found on the benchmark corpus (bench/corpus.json).
describe("glob references need an existing base directory (openhands/codex fps)", () => {
  it("skips slash-namespace globs whose first segment is not a repo dir", () => {
    // GitHub Action owners, MIME types, event namespaces — not file globs.
    const raw =
      "- GitHub-authored (`actions/*`, `github/*`) actions are exempt.\n" +
      "- The recorder treats textual media types (`text/*`) as safe.\n";
    expect(stalenessOf(raw, ["README.md"], ["src"])).toEqual([]);
  });

  it("still judges globs anchored in a real directory", () => {
    const findings = stalenessOf(
      "- Prompts live in `src/prompts/system_*.md`.\n",
      ["README.md", "src/index.ts"],
      ["src", "src/prompts"],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("stale-reference");
  });

  it("skips directory-less extension globs — pattern mentions, not locations", () => {
    expect(stalenessOf("- Delete stray `*.orig` files.\n", ["README.md"], [])).toEqual([]);
  });
});

describe("naming-convention placeholders are not path claims (vercel-ai fps)", () => {
  it("skips case-convention example filenames", () => {
    const raw =
      "- Source files: `kebab-case.ts`\n" +
      "- Test files: `kebab-case.test.ts`\n" +
      "- Components: `PascalCase.tsx`\n" +
      "- Modules: `snake_case.py`\n" +
      "- Hooks: `camelCase.ts`\n";
    expect(stalenessOf(raw, ["README.md"], [])).toEqual([]);
  });

  it("still flags ordinary missing files", () => {
    expect(stalenessOf("- See `missing-file.ts`.\n", ["README.md"], [])).toHaveLength(1);
  });
});

describe("CLAUDE.md @import redirects are not boilerplate (goose fps)", () => {
  it("does not flag a CLAUDE.md that consists of an @AGENTS.md import", () => {
    const surface = surfaceOf({ raw: "@AGENTS.md\n", kind: "claude-md", path: "CLAUDE.md" });
    const findings = analyzeStructure([surface], []);
    expect(findings.filter((f) => f.category === "structure")).toEqual([]);
  });

  it("still flags a genuinely empty CLAUDE.md", () => {
    const surface = surfaceOf({ raw: "# Notes\n", kind: "claude-md", path: "CLAUDE.md" });
    const findings = analyzeStructure([surface], []);
    expect(findings.some((f) => f.message.includes("empty or boilerplate"))).toBe(true);
  });
});
