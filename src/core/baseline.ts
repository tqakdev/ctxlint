import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha1Hex } from "./hash.js";
import type { Finding } from "./model.js";

/**
 * Baseline: accepted findings recorded so `--ci` fails only on NEW problems.
 * A repo adopting ctxlint runs `scan --write-baseline` once, commits the file,
 * and existing findings stop blocking while every regression still does.
 */

export const BASELINE_FILENAME = ".ctxlint-baseline.json";

export interface BaselineFile {
  version: 1;
  findings: string[];
}

/**
 * Line-move-stable identity for a finding. Rule ids are content hashes (they
 * survive reformatting and reordering), and digits are stripped from the
 * message so embedded line numbers and drifting token counts don't invalidate
 * an entry. Surface paths keep same-shaped findings in different files apart.
 */
export function findingFingerprint(
  finding: Finding,
  surfacePathById: ReadonlyMap<string, string>,
): string {
  const paths = finding.surfaceIds
    .map((id) => surfacePathById.get(id) ?? id)
    .sort()
    .join(",");
  const rules = [...finding.ruleIds].sort().join(",");
  const shape = finding.message.replace(/\d+/g, "#");
  return sha1Hex(`${finding.category}|${rules}|${paths}|${shape}`);
}

/** Read the baseline; undefined when absent, throws on a malformed file. */
export async function loadBaseline(root: string): Promise<Set<string> | undefined> {
  const file = path.join(root, BASELINE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: BaselineFile;
  try {
    parsed = JSON.parse(raw) as BaselineFile;
  } catch {
    throw new Error(
      `${BASELINE_FILENAME} is not valid JSON — regenerate it with scan --write-baseline`,
    );
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.findings)) {
    throw new Error(`${BASELINE_FILENAME} is malformed — regenerate it with scan --write-baseline`);
  }
  return new Set(parsed.findings.filter((f): f is string => typeof f === "string"));
}

export async function writeBaseline(root: string, fingerprints: string[]): Promise<string> {
  const file = path.join(root, BASELINE_FILENAME);
  const payload: BaselineFile = { version: 1, findings: [...new Set(fingerprints)].sort() };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

export interface BaselineResult {
  kept: Finding[];
  suppressed: number;
  /** Baseline entries that matched nothing — fixed findings, safe to prune. */
  stale: number;
}

export function applyBaseline(
  findings: Finding[],
  baseline: ReadonlySet<string>,
  surfacePathById: ReadonlyMap<string, string>,
): BaselineResult {
  const kept: Finding[] = [];
  const matched = new Set<string>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding, surfacePathById);
    if (baseline.has(fingerprint)) {
      matched.add(fingerprint);
    } else {
      kept.push(finding);
    }
  }
  return { kept, suppressed: findings.length - kept.length, stale: baseline.size - matched.size };
}
