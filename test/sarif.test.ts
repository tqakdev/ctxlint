import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/commands/scan.js";
import { runScan } from "../src/core/pipeline.js";
import { buildReportData, type ReportData } from "../src/report/data.js";
import { renderSarif } from "../src/report/sarif.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function messyReport(): Promise<ReportData> {
  const result = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
  return buildReportData(result);
}

interface SarifLog {
  version: string;
  $schema: string;
  runs: {
    tool: { driver: { name: string; rules: { id: string }[] } };
    results: {
      ruleId: string;
      level: string;
      message: { text: string };
      locations: {
        physicalLocation: {
          artifactLocation: { uri: string };
          region: { startLine: number; endLine: number };
        };
      }[];
    }[];
  }[];
}

describe("SARIF output", () => {
  it("attaches file/line locations to findings in the report data", async () => {
    const data = await messyReport();
    expect(data.version).toBe(2);
    expect(data.findings.length).toBeGreaterThan(0);
    for (const finding of data.findings) {
      expect(finding.locations.length).toBeGreaterThan(0);
      for (const location of finding.locations) {
        expect(location.path).toBeTruthy();
        expect(location.startLine).toBeGreaterThanOrEqual(1);
        expect(location.endLine).toBeGreaterThanOrEqual(location.startLine);
      }
    }
  });

  it("renders a SARIF 2.1.0 log with one result per finding", async () => {
    const data = await messyReport();
    const log = JSON.parse(renderSarif(data)) as SarifLog;
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif");
    const run = log.runs[0];
    expect(run?.tool.driver.name).toBe("ctxlint");
    expect(run?.results).toHaveLength(data.findings.length);
    // Every result references a declared rule (the finding category).
    const ruleIds = new Set(run?.tool.driver.rules.map((r) => r.id));
    for (const result of run?.results ?? []) {
      expect(ruleIds.has(result.ruleId)).toBe(true);
      expect(["error", "warning", "note"]).toContain(result.level);
      expect(result.message.text).toBeTruthy();
      expect(result.locations.length).toBeGreaterThan(0);
      const region = result.locations[0]?.physicalLocation.region;
      expect(region?.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it("maps severities error→error, warn→warning, info→note", async () => {
    const data = await messyReport();
    const log = JSON.parse(renderSarif(data)) as SarifLog;
    const results = log.runs[0]?.results ?? [];
    const expected = { error: "error", warn: "warning", info: "note" } as const;
    data.findings.forEach((finding, i) => {
      expect(results[i]?.level).toBe(expected[finding.severity]);
    });
  });

  it("is reachable via --format sarif dispatch", async () => {
    const data = await messyReport();
    expect(() => JSON.parse(renderReport(data, "sarif"))).not.toThrow();
    expect(() => renderReport(data, "nope")).toThrow(/sarif/);
  });
});
