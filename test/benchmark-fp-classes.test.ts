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

describe("package-relative references resolve via ancestor directories (opencode fps)", () => {
  it("resolves a ref written relative to an enclosing package root", () => {
    const surface = surfaceOf({
      raw: "- Use `testEffect(...)` from `test/lib/effect.ts` for Effect tests.\n",
      path: "packages/app/test/AGENTS.md",
      scope: "subtree",
    });
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(
        ["packages/app/test/lib/effect.ts", "packages/app/test/AGENTS.md"],
        ["packages", "packages/app", "packages/app/test", "packages/app/test/lib"],
      ),
    );
    expect(findings).toEqual([]);
  });

  it("resolves refs that omit the conventional src/ prefix", () => {
    const surface = surfaceOf({
      raw: "- `ToolStream` (`protocols/utils/tool-stream.ts`) accumulates tool calls.\n",
      path: "packages/llm/AGENTS.md",
      scope: "subtree",
    });
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(
        ["packages/llm/src/protocols/utils/tool-stream.ts", "packages/llm/AGENTS.md"],
        ["packages", "packages/llm", "packages/llm/src", "packages/llm/src/protocols"],
      ),
    );
    expect(findings).toEqual([]);
  });

  it("still flags a path that resolves from no base", () => {
    const surface = surfaceOf({
      raw: "- Use `test/lib/gone.ts`.\n",
      path: "packages/app/test/AGENTS.md",
      scope: "subtree",
    });
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(["packages/app/test/AGENTS.md"], ["packages", "packages/app", "packages/app/test"]),
    );
    expect(findings).toHaveLength(1);
  });
});

describe("bare filenames that exist somewhere are findable, not stale (browser-use/codex fps)", () => {
  it("does not flag a slash-less filename that exists elsewhere in the repo", () => {
    const findings = stalenessOf(
      "- Each component keeps its logic in a `service.py` file.\n",
      ["browser_use/agent/service.py"],
      ["browser_use", "browser_use/agent"],
    );
    expect(findings).toEqual([]);
  });

  it("still flags a slash-less filename that exists nowhere", () => {
    expect(stalenessOf("- See `totally-gone.ts`.\n", ["README.md"], [])).toHaveLength(1);
  });

  it("does not extend the leniency to full paths", () => {
    const findings = stalenessOf(
      "- Update `src/api/service.py` when adding routes.\n",
      ["browser_use/agent/service.py"],
      ["browser_use", "browser_use/agent", "src", "src/api"],
    );
    expect(findings).toHaveLength(1);
  });
});

describe("creation/removal/conditional contexts are not existence claims (openhands/vercel-ai fps)", () => {
  it("skips the object of a prohibited creation or usage", () => {
    const raw =
      "- Do not create flat top-level provider files like `src/flat/openai.ts`.\n" +
      "- Never: Recreate `gen/api` by hand.\n" +
      "- Do not use type prefixes such as `feat/` or `fix/`.\n" +
      "- Do not import generated code from `ui/desktop/src/api`.\n";
    expect(stalenessOf(raw, ["README.md"], ["src", "ui"])).toEqual([]);
  });

  it("skips the object of an instructed creation", () => {
    const raw =
      "- Create module-specific `conftest.py` files with database fixtures.\n" +
      "- Write an `opencode.json` config file for each sandbox.\n";
    expect(stalenessOf(raw, ["README.md"], [])).toEqual([]);
  });

  it("keeps a location claim inside a creation instruction", () => {
    const findings = stalenessOf(
      "- Create the definition in `src/prompts/tools/` (export the minimum).\n",
      ["README.md"],
      ["src"],
    );
    expect(findings).toHaveLength(1);
  });

  it("skips refs described as conditionally existing or removed", () => {
    const raw =
      "- When `.pr/` exists, a comment is posted to the PR conversation.\n" +
      "- You must manually remove `.pr/` before the PR can be merged.\n" +
      "- The `.pr/` directory is automatically removed on approval.\n";
    expect(stalenessOf(raw, ["README.md"], [])).toEqual([]);
  });
});

describe("import specifiers without extensions resolve by completion (opencode fps)", () => {
  it("resolves `./name` against name.ts in the surface directory", () => {
    const surface = surfaceOf({
      raw: "- `native-runtime.ts` imports LLMNative from `./native-request`.\n",
      path: "src/session/llm/AGENTS.md",
      scope: "subtree",
    });
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(
        [
          "src/session/llm/native-request.ts",
          "src/session/llm/native-runtime.ts",
          "src/session/llm/AGENTS.md",
        ],
        ["src", "src/session", "src/session/llm"],
      ),
    );
    expect(findings).toEqual([]);
  });
});

describe("token shapes that are never repo paths (cline/codex/opencode fps)", () => {
  it("ignores ellipsis paths, bare extensions, identifier.Json, and placeholder names", () => {
    const raw =
      "- Update `webview-ui/.../providerUtils.ts` when adding providers.\n" +
      "- Run codegen after any `.proto` change.\n" +
      "- Use `Schema.Json` for JSON-serializable values.\n" +
      "- If the module is `foo/index.ts`, use the self-reexport.\n" +
      "- Move passing tests into `tests/test_action_EventNameHere.py`.\n";
    expect(stalenessOf(raw, ["README.md"], ["webview-ui", "tests"])).toEqual([]);
  });

  it("ignores build-output and runtime directories and .env files anywhere", () => {
    const raw =
      "- Check `target/` for build artifacts and `logs/` for runtime issues.\n" +
      "- Set variables in `frontend/.env` before starting.\n";
    expect(stalenessOf(raw, ["README.md"], ["frontend"])).toEqual([]);
  });

  it("resolves paths written relative to a cd in the same rule", () => {
    const surface = surfaceOf({
      raw: "```bash\ncd examples/demo\npnpm tsx src/run.ts\n```\n",
    });
    const findings = analyzeStaleness(
      extractRules(surface),
      new Map([["s1", surface]]),
      facts(
        ["examples/demo/src/run.ts", "AGENTS.md"],
        ["examples", "examples/demo", "examples/demo/src"],
      ),
    );
    expect(findings).toEqual([]);
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

  it("does not call a short file with a real command boilerplate (opencode fp)", () => {
    const surface = surfaceOf({
      raw: "To start the stats site locally, run `bun dev:stats` from the repo root.\n",
      path: "packages/stats/AGENTS.md",
      scope: "subtree",
    });
    const findings = analyzeStructure([surface], []);
    expect(findings.filter((f) => f.message.includes("empty or boilerplate"))).toEqual([]);
  });
});
