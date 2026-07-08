import { sha1Hex } from "../src/core/hash.js";
import type { Finding } from "../src/core/model.js";

/** One pinned repo in the benchmark corpus. */
export interface CorpusEntry {
  /** Short unique slug used in snapshot filenames and finding keys. */
  name: string;
  /** GitHub owner/repo. */
  repo: string;
  /** Full 40-char commit SHA — the corpus only means something pinned. */
  sha: string;
  /** Why this repo is in the corpus (what context files it carries). */
  note: string;
}

/** Deterministic snapshot of one repo's scan — no timestamps, no abs paths. */
export interface BenchSnapshot {
  name: string;
  repo: string;
  sha: string;
  score: number;
  stats: { surfaces: number; rules: number };
  findings: { key: string; severity: string; category: string; message: string }[];
}

export type FindingLabel = "tp" | "fp";

/**
 * Identity of a finding within a pinned repo. Messages embed file/line, which
 * is stable because the corpus SHA is stable; evidence wording is not part of
 * the key so evidence-only rewordings keep labels valid.
 */
export function findingKey(repoName: string, finding: Finding): string {
  return sha1Hex(`${repoName}|${finding.category}|${finding.message}`);
}

export interface PrecisionReport {
  truePositives: number;
  falsePositives: number;
  unlabeled: number;
  /** truePositives / labeled, or null when nothing is labeled yet. */
  precision: number | null;
}

export function computePrecision(
  keys: string[],
  labels: Record<string, FindingLabel>,
): PrecisionReport {
  let truePositives = 0;
  let falsePositives = 0;
  let unlabeled = 0;
  for (const key of keys) {
    const label = labels[key];
    if (label === "tp") truePositives += 1;
    else if (label === "fp") falsePositives += 1;
    else unlabeled += 1;
  }
  const labeled = truePositives + falsePositives;
  return {
    truePositives,
    falsePositives,
    unlabeled,
    precision: labeled === 0 ? null : truePositives / labeled,
  };
}

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Returns human-readable problems; empty array = valid. */
export function validateCorpus(entries: CorpusEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) problems.push(`duplicate corpus name "${entry.name}"`);
    seen.add(entry.name);
    if (!REPO_SLUG.test(entry.repo)) {
      problems.push(`"${entry.name}": repo "${entry.repo}" is not an owner/repo slug`);
    }
    if (!FULL_SHA.test(entry.sha)) {
      problems.push(`"${entry.name}": sha "${entry.sha}" is not a full 40-char commit sha`);
    }
  }
  return problems;
}
