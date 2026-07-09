import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { type CtxlintConfig, DEFAULT_CONFIG } from "../config.js";
import { analyzeBudget } from "./analyzers/budget.js";
import { analyzeContradiction } from "./analyzers/contradiction.js";
import { analyzeDuplication } from "./analyzers/duplication.js";
import { analyzeStaleness } from "./analyzers/staleness.js";
import { analyzeStructure } from "./analyzers/structure.js";
import { discover, type RepoIndex } from "./discovery.js";
import {
  compareFindings,
  type EffectiveContext,
  type Finding,
  type Rule,
  type Surface,
} from "./model.js";
import { parseAll } from "./parsers/index.js";
import { resolveAll } from "./resolvers/index.js";
import { type ScoreReport, scoreFindings } from "./scoring.js";
import { ESTIMATE_LABEL, type ExactCounter } from "./tokens.js";

export interface ScanOptions {
  root: string;
  config?: CtxlintConfig;
  maxFiles?: number;
  /** Directory holding user-global config; null disables (tests). */
  userGlobalDir?: string | null;
  /** When provided (ANTHROPIC_API_KEY set), fills tokensExact per surface. */
  exactCounter?: ExactCounter;
}

export interface ScanResult {
  root: string;
  config: CtxlintConfig;
  surfaces: Surface[];
  rules: Rule[];
  effectiveContexts: EffectiveContext[];
  findings: Finding[];
  score: ScoreReport;
  index: RepoIndex;
  tokens: { method: "estimated" | "exact+estimated"; label: string };
}

/** A line that is nothing but the ignore marker (the "line above" form). */
const IGNORE_LINE = /^\s*<!--\s*ctxlint-ignore\s*-->\s*$/;

/**
 * Rules opted out with an inline `<!-- ctxlint-ignore -->` marker — on the
 * rule's own line(s), or standing alone on the line directly above (the
 * standalone form is strict so a marker on an adjacent list item never leaks
 * to its neighbor). Findings touching an ignored rule are dropped before
 * scoring; surface-level findings (budget, structure) have no rule line to
 * mark and are handled by the baseline instead.
 */
function collectIgnoredRuleIds(rules: Rule[], surfaces: Map<string, Surface>): Set<string> {
  const ignored = new Set<string>();
  const linesBySurface = new Map<string, string[]>();
  for (const rule of rules) {
    const surface = surfaces.get(rule.surfaceId);
    if (!surface) continue;
    let lines = linesBySurface.get(surface.id);
    if (!lines) {
      lines = surface.raw.split("\n");
      linesBySurface.set(surface.id, lines);
    }
    const above = lines[rule.span.startLine - 2];
    if (above !== undefined && IGNORE_LINE.test(above)) {
      ignored.add(rule.id);
      continue;
    }
    for (let i = rule.span.startLine - 1; i < Math.min(lines.length, rule.span.endLine); i++) {
      if ((lines[i] as string).includes("ctxlint-ignore")) {
        ignored.add(rule.id);
        break;
      }
    }
  }
  return ignored;
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  let rootStat: Stats;
  try {
    rootStat = await stat(options.root);
  } catch {
    throw new Error(`${options.root} does not exist — nothing to scan.`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${options.root} is not a directory — point ctxlint at a repo root.`);
  }

  const config = options.config ?? DEFAULT_CONFIG;
  const {
    surfaces,
    index,
    findings: discoveryFindings,
  } = await discover({
    root: options.root,
    maxFiles: options.maxFiles ?? config.discovery.maxFiles,
    maxSurfaceBytes: config.discovery.maxSurfaceBytes,
    exclude: config.discovery.exclude,
    userGlobalDir: options.userGlobalDir ?? null,
  });

  const { rules, findings: parseFindings } = parseAll(surfaces);

  let tokenMethod: ScanResult["tokens"]["method"] = "estimated";
  if (options.exactCounter) {
    for (const surface of surfaces) {
      try {
        surface.tokensExact = await options.exactCounter(surface.raw);
        tokenMethod = "exact+estimated";
      } catch {
        // Network failure — the estimate still stands.
      }
    }
  }

  const effectiveContexts = resolveAll(surfaces, index);

  const surfacesById = new Map(surfaces.map((s) => [s.id, s]));
  const ignoredRuleIds = collectIgnoredRuleIds(rules, surfacesById);
  const findings: Finding[] = [
    ...discoveryFindings,
    ...parseFindings,
    ...analyzeDuplication(rules, surfacesById, config.analysis.maxRules),
    ...analyzeContradiction(rules, surfacesById, config.analysis.maxRules),
    ...analyzeStaleness(rules, surfacesById, index),
    ...analyzeBudget(surfaces, rules, effectiveContexts, config.budgets),
    ...analyzeStructure(surfaces, rules),
  ]
    .filter((finding) => !finding.ruleIds.some((id) => ignoredRuleIds.has(id)))
    .sort(compareFindings);

  return {
    root: options.root,
    config,
    surfaces,
    rules,
    effectiveContexts,
    findings,
    score: scoreFindings(findings),
    index,
    tokens: {
      method: tokenMethod,
      label:
        tokenMethod === "estimated"
          ? ESTIMATE_LABEL
          : `exact Anthropic counts where available; otherwise ${ESTIMATE_LABEL}`,
    },
  };
}
