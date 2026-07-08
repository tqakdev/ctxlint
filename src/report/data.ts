import type { Finding, SurfaceKind, SurfaceScope, ToolId } from "../core/model.js";
import type { ScanResult } from "../core/pipeline.js";
import { TOOL_BEHAVIOR } from "../core/resolvers/toolBehavior.js";
import type { ScoreReport } from "../core/scoring.js";

/** Where a finding lives on disk — resolved from its rules (or surfaces). */
export interface FindingLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export type ReportFinding = Finding & { locations: FindingLocation[] };

/** Serializable report payload — written to the cache and fed to renderers. */
export interface ReportData {
  version: 2;
  generatedAt: string;
  root: string;
  tokenNote: string;
  score: ScoreReport;
  stats: { surfaces: number; rules: number; filesIndexed: number };
  surfaces: {
    id: string;
    path: string;
    kind: SurfaceKind;
    scope: SurfaceScope;
    tools: ToolId[];
    tokensEstimated: number;
    tokensExact?: number;
    ruleCount: number;
  }[];
  effectiveContexts: {
    tool: ToolId;
    directory: string;
    totalTokensEstimated: number;
    conditionalTokensEstimated: number;
    entries: {
      order: number;
      path: string;
      tokensEstimated: number;
      tokensExact?: number;
      reason: string;
      conditional: boolean;
    }[];
  }[];
  /** Provenance of the load-order model for each tool present in the scan. */
  toolBehavior: {
    tool: ToolId;
    docsUrl: string;
    lastVerified: string;
    assumptions: string[];
  }[];
  findings: ReportFinding[];
}

/** Resolve a finding to file/line locations via its rules, else its surfaces. */
function locateFinding(
  finding: Finding,
  ruleById: Map<string, { surfaceId: string; span: { startLine: number; endLine: number } }>,
  surfacePathById: Map<string, string>,
): FindingLocation[] {
  const locations: FindingLocation[] = [];
  const seen = new Set<string>();
  const add = (location: FindingLocation) => {
    const key = `${location.path}:${location.startLine}:${location.endLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      locations.push(location);
    }
  };
  for (const ruleId of finding.ruleIds) {
    const rule = ruleById.get(ruleId);
    const path = rule && surfacePathById.get(rule.surfaceId);
    if (rule && path) add({ path, startLine: rule.span.startLine, endLine: rule.span.endLine });
  }
  if (locations.length === 0) {
    for (const surfaceId of finding.surfaceIds) {
      const path = surfacePathById.get(surfaceId);
      if (path) add({ path, startLine: 1, endLine: 1 });
    }
  }
  return locations;
}

export function buildReportData(result: ScanResult, generatedAt = new Date()): ReportData {
  const ruleCounts = new Map<string, number>();
  for (const rule of result.rules) {
    ruleCounts.set(rule.surfaceId, (ruleCounts.get(rule.surfaceId) ?? 0) + 1);
  }
  const ruleById = new Map(result.rules.map((r) => [r.id, r]));
  const surfacePathById = new Map(result.surfaces.map((s) => [s.id, s.path]));
  return {
    version: 2,
    generatedAt: generatedAt.toISOString(),
    root: result.root,
    tokenNote: result.tokens.label,
    score: result.score,
    stats: {
      surfaces: result.surfaces.length,
      rules: result.rules.length,
      filesIndexed: result.index.files.length,
    },
    surfaces: result.surfaces.map((s) => ({
      id: s.id,
      path: s.path,
      kind: s.kind,
      scope: s.scope,
      tools: s.tools,
      tokensEstimated: s.tokensEstimated,
      ...(s.tokensExact !== undefined ? { tokensExact: s.tokensExact } : {}),
      ruleCount: ruleCounts.get(s.id) ?? 0,
    })),
    effectiveContexts: result.effectiveContexts.map((context) => ({
      tool: context.tool,
      directory: context.directory,
      totalTokensEstimated: context.totalTokensEstimated,
      conditionalTokensEstimated: context.conditionalTokensEstimated,
      entries: context.surfaces.map((entry) => ({
        order: entry.order,
        path: entry.surface.path,
        tokensEstimated: entry.surface.tokensEstimated,
        ...(entry.surface.tokensExact !== undefined
          ? { tokensExact: entry.surface.tokensExact }
          : {}),
        reason: entry.reason,
        conditional: entry.conditional ?? false,
      })),
    })),
    toolBehavior: [...new Set(result.effectiveContexts.map((c) => c.tool))].map((tool) => ({
      tool,
      ...TOOL_BEHAVIOR[tool],
    })),
    findings: result.findings.map((finding) => ({
      ...finding,
      locations: locateFinding(finding, ruleById, surfacePathById),
    })),
  };
}

export function countBySeverity(findings: Finding[]): {
  error: number;
  warn: number;
  info: number;
} {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
