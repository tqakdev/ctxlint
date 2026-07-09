import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_IDS } from "../src/core/model.js";
import { runScan } from "../src/core/pipeline.js";
import { TOOL_BEHAVIOR } from "../src/core/resolvers/toolBehavior.js";
import { buildReportData } from "../src/report/data.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("versioned tool-behavior data", () => {
  it("documents every known tool with a docs link and a last-verified date", () => {
    for (const tool of TOOL_IDS) {
      const behavior = TOOL_BEHAVIOR[tool];
      expect(behavior, tool).toBeDefined();
      expect(behavior.docsUrl, tool).toMatch(/^https:\/\//);
      expect(behavior.lastVerified, tool).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(behavior.lastVerified)), tool).toBe(false);
    }
  });

  it("lists the load-order assumptions the resolver makes", () => {
    // Every resolver marks unconfirmed behavior "(assumed)" in its reasons;
    // the data file must carry those same caveats so they can be re-verified.
    expect(TOOL_BEHAVIOR["claude-code"].assumptions.length).toBeGreaterThan(0);
    expect(TOOL_BEHAVIOR.cursor.assumptions.length).toBeGreaterThan(0);
  });

  it("surfaces behavior provenance only for tools that load at least one surface", async () => {
    const result = await runScan({ root: path.join(fixtures, "clean-repo"), userGlobalDir: null });
    const data = buildReportData(result);
    expect(data.toolBehavior.length).toBeGreaterThan(0);
    const toolsLoading = new Set(
      data.effectiveContexts.filter((c) => c.entries.length > 0).map((c) => c.tool),
    );
    expect(new Set(data.toolBehavior.map((b) => b.tool))).toEqual(toolsLoading);
    // clean-repo has no windsurf files — no provenance row for windsurf.
    expect(data.toolBehavior.some((b) => b.tool === "windsurf")).toBe(false);
    for (const entry of data.toolBehavior) {
      expect(entry.docsUrl).toMatch(/^https:\/\//);
      expect(entry.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
