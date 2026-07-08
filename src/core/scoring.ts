import type { Finding, FindingCategory, Severity } from "./model.js";

/**
 * Context Health Score — deterministic and documented.
 *
 * Five subscores, each starting at 100 with per-finding penalties
 * (error 25, warn 10, info 4):
 *
 *   freshness    <- stale-reference
 *   uniqueness   <- duplication
 *   consistency  <- drift, contradiction
 *   budget       <- budget
 *   structure    <- structure, load-semantics, dead-rule
 *
 * Within a subscore, penalties are sorted worst-first and each repeat counts
 * REPEAT_DECAY times the previous one, so the first error costs the full 25
 * but the tenth doesn't flatline the score — the subscore keeps moving as a
 * repo gets better or worse instead of saturating at 0 (it still reaches 0
 * around 8 errors). Subscores are rounded and floored at 0.
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

/** Each additional finding in a subscore counts this fraction of the previous. */
const REPEAT_DECAY = 0.8;

const WEIGHTS: Record<SubscoreName, number> = {
  freshness: 0.25,
  uniqueness: 0.2,
  consistency: 0.25,
  budget: 0.15,
  structure: 0.15,
};

export function scoreFindings(findings: Finding[]): ScoreReport {
  const penaltiesBySubscore: Record<SubscoreName, number[]> = {
    freshness: [],
    uniqueness: [],
    consistency: [],
    budget: [],
    structure: [],
  };
  for (const finding of findings) {
    penaltiesBySubscore[CATEGORY_TO_SUBSCORE[finding.category]].push(PENALTY[finding.severity]);
  }

  const subscores = {} as Record<SubscoreName, number>;
  let total = 0;
  for (const name of Object.keys(WEIGHTS) as SubscoreName[]) {
    // Worst-first so the biggest penalties always carry full weight.
    const penalties = penaltiesBySubscore[name].sort((a, b) => b - a);
    let totalPenalty = 0;
    let decay = 1;
    for (const penalty of penalties) {
      totalPenalty += penalty * decay;
      decay *= REPEAT_DECAY;
    }
    subscores[name] = Math.max(0, Math.round(100 - totalPenalty));
    total += WEIGHTS[name] * subscores[name];
  }
  return { total: Math.round(total), subscores };
}
