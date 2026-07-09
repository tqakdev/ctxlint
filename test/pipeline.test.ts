import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { excludeToGlobs } from "../src/core/discovery.js";
import type { ScanResult } from "../src/core/pipeline.js";
import { runScan } from "../src/core/pipeline.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function scanFixture(name: string): Promise<ScanResult> {
  return runScan({ root: path.join(fixtures, name), userGlobalDir: null });
}

/** Stable projection for snapshots: no absolute paths, no timestamps. */
function project(result: ScanResult) {
  return {
    score: result.score,
    surfaces: result.surfaces.map((s) => ({
      path: s.path,
      kind: s.kind,
      scope: s.scope,
      tools: s.tools,
      tokens: s.tokensEstimated,
    })),
    contexts: result.effectiveContexts.map((context) => ({
      tool: context.tool,
      dir: context.directory,
      alwaysOnTokens: context.totalTokensEstimated,
      conditionalTokens: context.conditionalTokensEstimated,
      files: context.surfaces.map(
        (e) => `${e.order}. ${e.surface.path}${e.conditional ? " (conditional)" : ""}`,
      ),
    })),
    findings: result.findings.map((f) => `[${f.severity}][${f.category}] ${f.message}`),
  };
}

describe("M1 pipeline snapshots", () => {
  it("clean-repo", async () => {
    expect(project(await scanFixture("clean-repo"))).toMatchSnapshot();
  });

  it("messy-repo", async () => {
    expect(project(await scanFixture("messy-repo"))).toMatchSnapshot();
  });

  it("monorepo", async () => {
    expect(project(await scanFixture("monorepo"))).toMatchSnapshot();
  });
});

describe("monorepo subtree resolution", () => {
  it("claude-code working in packages/web loads the subtree CLAUDE.md and AGENTS.md chain", async () => {
    const result = await scanFixture("monorepo");
    const context = result.effectiveContexts.find(
      (c) => c.tool === "claude-code" && c.directory === "packages/web",
    );
    expect(context).toBeDefined();
    const paths = context?.surfaces.map((e) => e.surface.path);
    expect(paths).toEqual(["packages/web/CLAUDE.md", "AGENTS.md", "packages/web/AGENTS.md"]);
  });

  it("cursor glob rules activate under packages/web but not packages/api", async () => {
    const result = await scanFixture("monorepo");
    const entryFor = (dir: string) =>
      result.effectiveContexts
        .find((c) => c.tool === "cursor" && c.directory === dir)
        ?.surfaces.find((e) => e.surface.path === ".cursor/rules/web.mdc");
    expect(entryFor("packages/web")?.reason).toContain("activates for files matching");
    expect(entryFor("packages/api")?.reason).toContain("match nothing under packages/api");
    expect(entryFor("packages/web")?.conditional).toBe(true);
  });

  it("codex sees the AGENTS.md hierarchy root -> subtree", async () => {
    const result = await scanFixture("monorepo");
    const context = result.effectiveContexts.find(
      (c) => c.tool === "codex" && c.directory === "packages/api",
    );
    expect(context?.surfaces.map((e) => e.surface.path)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
    ]);
    expect(context?.totalTokensEstimated).toBeGreaterThan(0);
  });

  it("skills are inventoried but never counted into effective contexts", async () => {
    const result = await scanFixture("monorepo");
    expect(result.surfaces.some((s) => s.kind === "skill")).toBe(true);
    for (const context of result.effectiveContexts) {
      expect(context.surfaces.some((e) => e.surface.kind === "skill")).toBe(false);
    }
  });
});

describe("nested rule glob activation", () => {
  it("activates nested .mdc globs under both repo-relative and rule-dir-relative readings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-nested-"));
    await mkdir(path.join(dir, "packages/web/.cursor/rules"), { recursive: true });
    await mkdir(path.join(dir, "packages/web/src"), { recursive: true });
    // Rule-dir-relative glob: no packages/web/ prefix — the reading Cursor's
    // docs don't rule out and repo-relative matching alone would miss.
    await writeFile(
      path.join(dir, "packages/web/.cursor/rules/web.mdc"),
      '---\ndescription: web\nglobs: ["src/**/*.tsx"]\nalwaysApply: false\n---\n- Keep components pure.\n',
      "utf8",
    );
    await writeFile(path.join(dir, "packages/web/src/app.tsx"), "export const x = 1;\n", "utf8");

    const result = await runScan({ root: dir, userGlobalDir: null });
    const context = result.effectiveContexts.find(
      (c) => c.tool === "cursor" && c.directory === "packages/web",
    );
    const entry = context?.surfaces.find(
      (e) => e.surface.path === "packages/web/.cursor/rules/web.mdc",
    );
    expect(entry).toBeDefined();
    expect(entry?.conditional).toBe(true);
    expect(entry?.reason).toContain("activates for files matching");

    // A glob matching nothing under either reading still says so.
    await writeFile(
      path.join(dir, "packages/web/.cursor/rules/none.mdc"),
      '---\nglobs: ["nothing/**"]\nalwaysApply: false\n---\n- Never applies.\n',
      "utf8",
    );
    const rescan = await runScan({ root: dir, userGlobalDir: null });
    const none = rescan.effectiveContexts
      .find((c) => c.tool === "cursor" && c.directory === "packages/web")
      ?.surfaces.find((e) => e.surface.path === "packages/web/.cursor/rules/none.mdc");
    expect(none?.reason).toContain("match nothing");
  });
});

describe("windsurf support", () => {
  it("discovers and classifies .windsurfrules and .windsurf/rules/*.md", async () => {
    const result = await scanFixture("windsurf-repo");
    const byPath = new Map(result.surfaces.map((s) => [s.path, s]));
    expect(byPath.get(".windsurfrules")?.kind).toBe("windsurf-rule");
    expect(byPath.get(".windsurfrules")?.tools).toEqual(["windsurf"]);
    expect(byPath.get(".windsurfrules")?.scope).toBe("repo-root");
    expect(byPath.get(".windsurf/rules/always.md")?.kind).toBe("windsurf-rule");
    expect(byPath.get(".windsurf/rules/always.md")?.tools).toEqual(["windsurf"]);
    expect(byPath.get(".windsurf/rules/web.md")?.scope).toBe("repo-root");
  });

  it("parses windsurf rule frontmatter (trigger/globs) into surface meta", async () => {
    const result = await scanFixture("windsurf-repo");
    const web = result.surfaces.find((s) => s.path === ".windsurf/rules/web.md");
    expect(web?.meta?.trigger).toBe("glob");
    expect(web?.meta?.globs).toEqual(["src/**"]);
    const always = result.surfaces.find((s) => s.path === ".windsurf/rules/always.md");
    expect(always?.meta?.trigger).toBe("always_on");
  });

  it("resolves the windsurf effective context with correct activation", async () => {
    const result = await scanFixture("windsurf-repo");
    const context = result.effectiveContexts.find(
      (c) => c.tool === "windsurf" && c.directory === ".",
    );
    expect(context).toBeDefined();
    const entry = (p: string) => context?.surfaces.find((e) => e.surface.path === p);
    expect(entry(".windsurfrules")?.conditional).toBeFalsy();
    expect(entry(".windsurf/rules/always.md")?.conditional).toBeFalsy();
    expect(entry(".windsurf/rules/web.md")?.conditional).toBe(true);
  });

  it("detects duplication between AGENTS.md and windsurf rules across tools", async () => {
    const result = await scanFixture("windsurf-repo");
    const dupes = result.findings.filter((f) => f.category === "duplication");
    expect(dupes.length).toBeGreaterThan(0);
    // AGENTS.md outranks windsurf rules — the windsurf copy is the one to delete.
    const plan = (await import("../src/fix/planner.js")).planFixes(result, new Map());
    const deletes = plan.fixes.filter((f) => f.safe && f.kind === "delete-rule");
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes[0]?.edits[0]?.file).toBe(".windsurfrules");
  });
});

describe("discovery.exclude", () => {
  function configExcluding(...exclude: string[]) {
    return {
      ...DEFAULT_CONFIG,
      discovery: { ...DEFAULT_CONFIG.discovery, exclude },
    };
  }

  it("excluded files are not surfaces but stay in the repo index", async () => {
    const result = await runScan({
      root: path.join(fixtures, "messy-repo"),
      config: configExcluding(".cursor"),
      userGlobalDir: null,
    });
    expect(result.surfaces.some((s) => s.path.startsWith(".cursor/"))).toBe(false);
    expect(result.surfaces.some((s) => s.path === "CLAUDE.md")).toBe(true);
    expect(result.index.fileSet.has(".cursor/rules/style.mdc")).toBe(true);
  });

  it("glob patterns are honored as written", async () => {
    const result = await runScan({
      root: path.join(fixtures, "messy-repo"),
      config: configExcluding("**/*.mdc"),
      userGlobalDir: null,
    });
    expect(result.surfaces.some((s) => s.path.endsWith(".mdc"))).toBe(false);
    expect(result.surfaces.some((s) => s.path === "CLAUDE.md")).toBe(true);
  });

  it("bare paths also exclude their subtree; glob patterns pass through", () => {
    expect(excludeToGlobs(["test/fixtures", "docs/"])).toEqual([
      "test/fixtures",
      "test/fixtures/**",
      "docs",
      "docs/**",
    ]);
    expect(excludeToGlobs(["examples/**/*.md", ""])).toEqual(["examples/**/*.md"]);
  });
});

describe("discovery edge cases", () => {
  it("rejects a nonexistent scan root with a clear error", async () => {
    await expect(
      runScan({ root: "/nonexistent-dir-ctxlint-test", userGlobalDir: null }),
    ).rejects.toThrow(/is not a directory|does not exist/);
  });

  it("rejects a scan root that is a file, not a directory", async () => {
    const file = path.join(fixtures, "messy-repo", "CLAUDE.md");
    await expect(runScan({ root: file, userGlobalDir: null })).rejects.toThrow(
      /is not a directory|does not exist/,
    );
  });

  it("classifies every fixture surface with the right kind and tools", async () => {
    const result = await scanFixture("messy-repo");
    const byPath = new Map(result.surfaces.map((s) => [s.path, s]));
    expect(byPath.get("CLAUDE.md")?.tools).toEqual(["claude-code"]);
    expect(byPath.get(".cursor/rules/style.mdc")?.tools).toEqual(["cursor"]);
    expect(byPath.get(".github/copilot-instructions.md")?.tools).toEqual(["copilot"]);
    expect(byPath.get(".cursorrules")?.tools).toEqual([]);
  });

  it("parses .mdc frontmatter into surface meta", async () => {
    const result = await scanFixture("monorepo");
    const web = result.surfaces.find((s) => s.path === ".cursor/rules/web.mdc");
    expect(web?.meta?.globs).toEqual(["packages/web/**"]);
    expect(web?.meta?.alwaysApply).toBe(false);
  });

  it("survives broken .mdc frontmatter with a finding instead of a crash", async () => {
    const result = await scanFixture("messy-repo");
    const broken = result.surfaces.find((s) => s.path === ".cursor/rules/broken.mdc");
    expect(broken?.meta?.frontmatterError).toBeDefined();
    expect(
      result.findings.some(
        (f) => f.category === "structure" && f.message.includes("broken frontmatter"),
      ),
    ).toBe(true);
    // Rules were still extracted from the body.
    expect(result.rules.some((r) => r.surfaceId === broken?.id)).toBe(true);
  });
});
