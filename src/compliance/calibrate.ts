import type { JudgedPair, JudgePair } from "./judge.js";

/**
 * Calibration: re-judge a deterministic sample with a second model and report
 * agreement. Below the agreement threshold, per-rule scores must be presented
 * as directional only — this honesty check is the product's credibility.
 */

/** Every k-th judged pair (sorted for determinism), at least one. */
export function pickCalibrationSample(pairs: JudgedPair[], ratio: number): JudgePair[] {
  const judged = pairs.filter((p) => p.verdict !== undefined);
  if (judged.length === 0) return [];
  const sorted = [...judged].sort((a, b) =>
    `${a.rule.id}|${a.chunk.id}`.localeCompare(`${b.rule.id}|${b.chunk.id}`),
  );
  const step = Math.max(1, Math.floor(1 / Math.max(ratio, 0.0001)));
  const sample: JudgePair[] = [];
  for (let i = 0; i < sorted.length; i += step) {
    const { rule, chunk } = sorted[i] as JudgedPair;
    sample.push({ rule, chunk });
  }
  return sample;
}

export interface AgreementReport {
  compared: number;
  agreed: number;
  agreement: number;
}

export function agreementReport(
  primary: JudgedPair[],
  secondary: JudgedPair[],
): AgreementReport {
  const primaryByKey = new Map(
    primary
      .filter((p) => p.verdict !== undefined)
      .map((p) => [`${p.rule.id}|${p.chunk.id}`, p.verdict]),
  );
  let compared = 0;
  let agreed = 0;
  for (const pair of secondary) {
    if (pair.verdict === undefined) continue;
    const first = primaryByKey.get(`${pair.rule.id}|${pair.chunk.id}`);
    if (first === undefined) continue;
    compared += 1;
    if (first === pair.verdict) agreed += 1;
  }
  return { compared, agreed, agreement: compared === 0 ? 0 : agreed / compared };
}
