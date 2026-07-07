import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (...parts: string[]) => readFileSync(path.join(fixtures, ...parts), "utf8");
const exists = (...parts: string[]) => existsSync(path.join(fixtures, ...parts));

describe("clean-repo fixture", () => {
  it("has a single AGENTS.md and no per-tool duplicates", () => {
    expect(exists("clean-repo", "AGENTS.md")).toBe(true);
    expect(exists("clean-repo", "CLAUDE.md")).toBe(false);
    expect(exists("clean-repo", ".cursor")).toBe(false);
    expect(exists("clean-repo", ".github", "copilot-instructions.md")).toBe(false);
  });

  it("only references paths that exist", () => {
    for (const p of ["src/index.ts", "src/server.ts", "src/lib/db.ts", "src/lib/validate.ts"]) {
      expect(read("clean-repo", "AGENTS.md")).toContain(p);
      expect(exists("clean-repo", ...p.split("/"))).toBe(true);
    }
  });

  it("only references npm scripts that exist", () => {
    const pkg = JSON.parse(read("clean-repo", "package.json")) as {
      scripts: Record<string, string>;
    };
    for (const script of ["build", "test", "lint"]) {
      expect(pkg.scripts[script]).toBeDefined();
    }
  });

  it("stays under the surface token budget", () => {
    const tokens = getEncoding("o200k_base").encode(read("clean-repo", "AGENTS.md")).length;
    expect(tokens).toBeLessThan(1500);
  });
});

describe("messy-repo fixture", () => {
  it("has an oversized CLAUDE.md (~3k estimated tokens)", () => {
    const tokens = getEncoding("o200k_base").encode(read("messy-repo", "CLAUDE.md")).length;
    expect(tokens).toBeGreaterThan(2500);
  });

  it("buries the critical migration rule past 70% depth", () => {
    const lines = read("messy-repo", "CLAUDE.md").split("\n");
    const index = lines.findIndex((l) => l.includes("NEVER run `npm run migrate`"));
    expect(index).toBeGreaterThan(-1);
    expect(index / lines.length).toBeGreaterThan(0.7);
  });

  it("duplicates the validation rule verbatim across CLAUDE.md and style.mdc", () => {
    const block =
      "All API route handlers must validate request bodies with the schemas in `src/schemas/`";
    expect(read("messy-repo", "CLAUDE.md")).toContain(block);
    expect(read("messy-repo", ".cursor", "rules", "style.mdc")).toContain(block);
  });

  it("carries a drifted workflow rule between CLAUDE.md and copilot-instructions", () => {
    // Markdown hard-wraps lines, so compare on whitespace-normalized text.
    // The two rules differ by exactly one word (main -> develop): close enough
    // that 5-gram Jaccard lands in the drift band, not the duplication band.
    const claude = read("messy-repo", "CLAUDE.md").replace(/\s+/g, " ");
    const copilot = read("messy-repo", ".github", "copilot-instructions.md").replace(/\s+/g, " ");
    expect(claude).toContain("pull request against the `main` branch");
    expect(copilot).toContain("pull request against the `develop` branch");
    expect(claude).toContain("at least one backend engineer");
    expect(copilot).toContain("at least one backend engineer");
  });

  it("contradicts itself on exports across surfaces", () => {
    expect(read("messy-repo", ".cursor", "rules", "style.mdc")).toContain(
      "Never use default exports",
    );
    expect(read("messy-repo", ".github", "copilot-instructions.md")).toContain(
      "Always use default exports",
    );
  });

  it("references paths and scripts that do not exist (stale)", () => {
    const claude = read("messy-repo", "CLAUDE.md");
    for (const stale of [
      "src/api/v1/",
      "docs/architecture.md",
      "src/utils/date-helpers.js",
      "scripts/seed-db.sh",
    ]) {
      expect(claude).toContain(stale);
      expect(exists("messy-repo", ...stale.replace(/\/$/, "").split("/"))).toBe(false);
    }
    const pkg = JSON.parse(read("messy-repo", "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(claude).toContain("npm run lint");
    expect(claude).toContain("npm run typecheck");
    expect(pkg.scripts.lint).toBeUndefined();
    expect(pkg.scripts.typecheck).toBeUndefined();
  });

  it("has a legacy .cursorrules no v1 tool loads", () => {
    expect(exists("messy-repo", ".cursorrules")).toBe(true);
  });

  it("has an .mdc with frontmatter that breaks gray-matter", () => {
    const raw = read("messy-repo", ".cursor", "rules", "broken.mdc");
    expect(() => matter(raw)).toThrow();
  });
});

describe("monorepo fixture", () => {
  it("has root and nested AGENTS.md plus a subtree CLAUDE.md", () => {
    expect(exists("monorepo", "AGENTS.md")).toBe(true);
    expect(exists("monorepo", "packages", "api", "AGENTS.md")).toBe(true);
    expect(exists("monorepo", "packages", "web", "AGENTS.md")).toBe(true);
    expect(exists("monorepo", "packages", "web", "CLAUDE.md")).toBe(true);
  });

  it("has cursor rules with parseable activation frontmatter", () => {
    const web = matter(read("monorepo", ".cursor", "rules", "web.mdc"));
    expect(web.data.globs).toEqual(["packages/web/**"]);
    expect(web.data.alwaysApply).toBe(false);

    const repo = matter(read("monorepo", ".cursor", "rules", "repo.mdc"));
    expect(repo.data.alwaysApply).toBe(true);
    expect(repo.data.globs).toBeUndefined();
  });
});
