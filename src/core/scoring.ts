import type { Finding, FindingCategory, Severity } from "./model.js";

/**
 * Context Health Score — deterministic and documented.
 *
 * Five subscores, each starting at 100 with per-finding penalties
 * (error 25, warn 10, info 4; floored at 0):
 *
 *   freshness    <- stale-reference
 *   uniqueness   <- duplication
 *   consistency  <- drift, contradiction
 *   budget       <- budget
 *   structure    <- structure, load-semantics, dead-rule
 *
 * Total = round(0.25*freshness + 0.20*uniqueness + 0.25*consistency
 *             + 0.15*budget + 0.15*structure)
 *
 * Same findings in, same score out — there is no randomness and no clock.
 */

export type SubscoreName = "freshness" | "uniqueness" | "consistency" | "budget" | "structure";

export interface ScoreReport {
  total: number;
  subscores: Record<SubscoreName, number>;
}

const CATEGORY_TO_SUBSCORE: Record<FindingCategory, SubscoreName> = {
  "stale-reference": "freshness",
  duplication: "uniqueness",
  drift: "consistency",
  contradiction: "consistency",
  budget: "budget",
  structure: "structure",
  "load-semantics": "structure",
  "dead-rule": "structure",
};

const PENALTY: Record<Severity, number> = { error: 25, warn: 10, info: 4 };

const WEIGHTS: Record<SubscoreName, number> = {
  freshness: 0.25,
  uniqueness: 0.2,
  consistency: 0.25,
  budget: 0.15,
  structure: 0.15,
};

export function scoreFindings(findings: Finding[]): ScoreReport {
  const subscores: Record<SubscoreName, number> = {
    freshness: 100,
    uniqueness: 100,
    consistency: 100,
    budget: 100,
    structure: 100,
  };
  for (const finding of findings) {
    const name = CATEGORY_TO_SUBSCORE[finding.category];
    subscores[name] = Math.max(0, subscores[name] - PENALTY[finding.severity]);
  }
  let total = 0;
  for (const name of Object.keys(WEIGHTS) as SubscoreName[]) {
    total += WEIGHTS[name] * subscores[name];
  }
  return { total: Math.round(total), subscores };
}
