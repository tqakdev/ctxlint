import type { Finding, SurfaceKind, SurfaceScope, ToolId } from "../core/model.js";
import type { ScanResult } from "../core/pipeline.js";
import type { ScoreReport } from "../core/scoring.js";

/** Serializable report payload — written to the cache and fed to renderers. */
export interface ReportData {
  version: 1;
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
  findings: Finding[];
}

export function buildReportData(result: ScanResult, generatedAt = new Date()): ReportData {
  const ruleCounts = new Map<string, number>();
  for (const rule of result.rules) {
    ruleCounts.set(rule.surfaceId, (ruleCounts.get(rule.surfaceId) ?? 0) + 1);
  }
  return {
    version: 1,
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
    findings: result.findings,
  };
}

export function countBySeverity(findings: Finding[]): { error: number; warn: number; info: number } {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
