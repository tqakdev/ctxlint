import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
