import type { JudgedPair, JudgePair } from "./judge.js";

/**
 * Calibration: re-judge a deterministic sample with a second model and report
 * agreement. Below the agreement threshold, per-rule scores must be presented
 * as directional only — this honesty check is the product's credibility.
 */

/** Every k-th pair (sorted for determinism), at least one when non-empty. */
export function pickCalibrationPairs<T extends JudgePair>(pairs: T[], ratio: number): T[] {
  if (pairs.length === 0) return [];
  const sorted = [...pairs].sort((a, b) =>
    `${a.rule.id}|${a.chunk.id}`.localeCompare(`${b.rule.id}|${b.chunk.id}`),
  );
  const step = Math.max(1, Math.floor(1 / Math.max(ratio, 0.0001)));
  const sample: T[] = [];
  for (let i = 0; i < sorted.length; i += step) {
    sample.push(sorted[i] as T);
  }
  return sample;
}

/** Every k-th judged pair (sorted for determinism), at least one. */
export function pickCalibrationSample(pairs: JudgedPair[], ratio: number): JudgePair[] {
  return pickCalibrationPairs(
    pairs.filter((p) => p.verdict !== undefined),
    ratio,
  ).map(({ rule, chunk }) => ({ rule, chunk }));
}

export interface AgreementReport {
  compared: number;
  agreed: number;
  agreement: number;
}

export function agreementReport(primary: JudgedPair[], secondary: JudgedPair[]): AgreementReport {
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
