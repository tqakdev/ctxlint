import { describe, expect, it } from "vitest";
import { analyzeStaleness, type RepoFacts } from "../src/core/analyzers/staleness.js";
import type { Surface } from "../src/core/model.js";
import { extractRules } from "../src/core/parsers/markdown.js";

function surfaceAt(path: string, raw: string): Surface {
  return {
    id: "s1",
    path,
    kind: "agents-md",
    scope: "subtree",
    tools: [],
    raw,
    tokensEstimated: 0,
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

describe("staleness: ./-prefixed references from subdirectory surfaces (cline benchmark bug)", () => {
  it("resolves ./file relative to the surface's directory", () => {
    const surface = surfaceAt("sdk/AGENTS.md", "- See `./ARCHITECTURE.md` for details.\n");
    const rules = extractRules(surface);
    expect(rules[0]?.referencedPaths).toContain("./ARCHITECTURE.md");
    const findings = analyzeStaleness(
      rules,
      new Map([["s1", surface]]),
      facts(["sdk/ARCHITECTURE.md", "sdk/AGENTS.md"], ["sdk"]),
    );
    expect(findings).toEqual([]);
  });

  it("resolves ./nested/path relative to the surface's directory", () => {
    const surface = surfaceAt("sdk/AGENTS.md", "- Follow `./packages/llms/AGENTS.md`.\n");
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(["sdk/packages/llms/AGENTS.md", "sdk/AGENTS.md"], ["sdk", "sdk/packages"]),
    );
    expect(findings).toEqual([]);
  });

  it("resolves ../file relative to the surface's directory (opencode benchmark bug)", () => {
    const surface = surfaceAt(
      "packages/opencode/src/session/llm/AGENTS.md",
      "- `../llm.ts` is the opencode session LLM service.\n",
    );
    const rules = extractRules(surface);
    expect(rules[0]?.referencedPaths).toContain("../llm.ts");
    const findings = analyzeStaleness(
      rules,
      new Map([["s1", surface]]),
      facts(
        ["packages/opencode/src/session/llm.ts", "packages/opencode/src/session/llm/AGENTS.md"],
        ["packages", "packages/opencode", "packages/opencode/src", "packages/opencode/src/session"],
      ),
    );
    expect(findings).toEqual([]);
  });

  it("does not let ../ escape above the repo root", () => {
    const surface = surfaceAt("sdk/AGENTS.md", "- See `../../outside.md`.\n");
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(["outside.md", "sdk/AGENTS.md"], ["sdk"]),
    );
    // ../../ from sdk/ points outside the repo; the root-level outside.md is
    // not what the author referenced, but the reference cannot be judged, so
    // the analyzer must not crash — and must not false-positive on it either.
    expect(findings).toEqual([]);
  });

  it("still flags ./file that exists in neither the surface dir nor the root", () => {
    const surface = surfaceAt("sdk/AGENTS.md", "- See `./GONE.md`.\n");
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(["sdk/AGENTS.md"], ["sdk"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("stale-reference");
  });
});
