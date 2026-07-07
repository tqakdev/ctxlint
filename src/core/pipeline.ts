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

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const {
    surfaces,
    index,
    findings: discoveryFindings,
  } = await discover({
    root: options.root,
    maxFiles: options.maxFiles ?? config.discovery.maxFiles,
    maxSurfaceBytes: config.discovery.maxSurfaceBytes,
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
  const findings: Finding[] = [
    ...discoveryFindings,
    ...parseFindings,
    ...analyzeDuplication(rules, surfacesById, config.analysis.maxRules),
    ...analyzeContradiction(rules, surfacesById, config.analysis.maxRules),
    ...analyzeStaleness(rules, surfacesById, index),
    ...analyzeBudget(surfaces, rules, effectiveContexts, config.budgets),
    ...analyzeStructure(surfaces, rules),
  ].sort(compareFindings);

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
