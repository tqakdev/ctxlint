import { createRequire } from "node:module";
import type { FindingCategory, Severity } from "../core/model.js";
import type { ReportData } from "./data.js";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
  homepage?: string;
};

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  error: "error",
  warn: "warning",
  info: "note",
};

const CATEGORY_DESCRIPTION: Record<FindingCategory, string> = {
  duplication: "Near-identical rules repeated across context files.",
  drift: "Copies of a rule that have drifted apart.",
  contradiction: "Rules that contradict each other.",
  "stale-reference": "Rule references a path or script that does not exist.",
  budget: "Effective context exceeds a sensible token budget.",
  structure: "Structural problem in a context file.",
  "dead-rule": "Rule that no known tool will ever load.",
  "load-semantics": "File loads differently than its placement suggests.",
};

/**
 * SARIF 2.1.0 log: one reportingDescriptor per finding category, one result
 * per finding. Plugs into GitHub code scanning and other SARIF consumers.
 */
export function renderSarif(data: ReportData): string {
  const categories = [...new Set(data.findings.map((f) => f.category))].sort();
  const log = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ctxlint",
            semanticVersion: pkg.version,
            informationUri: pkg.homepage ?? "https://github.com/tqakdev/ctxlint",
            rules: categories.map((category) => ({
              id: category,
              shortDescription: { text: CATEGORY_DESCRIPTION[category] },
            })),
          },
        },
        results: data.findings.map((finding) => ({
          ruleId: finding.category,
          level: SARIF_LEVEL[finding.severity],
          message: { text: finding.message },
          locations: finding.locations.map((location) => ({
            physicalLocation: {
              artifactLocation: { uri: location.path, uriBaseId: "%SRCROOT%" },
              region: { startLine: location.startLine, endLine: location.endLine },
            },
          })),
          properties: { evidence: finding.evidence },
        })),
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
