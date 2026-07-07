import type { Finding, Rule, Surface } from "../model.js";
import { diffWords, jaccard, normalizeWords, shingles } from "./shingles.js";

export const DUPLICATION_THRESHOLD = 0.9;
export const DRIFT_THRESHOLD = 0.6;

interface Prepared {
  rule: Rule;
  words: string[];
  shingleSet: Set<string>;
}

function location(rule: Rule, surfaces: Map<string, Surface>): string {
  const surfacePath = surfaces.get(rule.surfaceId)?.path ?? rule.surfaceId;
  return `${surfacePath}:${rule.span.startLine}-${rule.span.endLine}`;
}

function quote(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function differentTools(a: Surface | undefined, b: Surface | undefined): boolean {
  const setA = new Set(a?.tools ?? []);
  const setB = new Set(b?.tools ?? []);
  if (setA.size !== setB.size) return true;
  for (const tool of setA) if (!setB.has(tool)) return true;
  return false;
}

/**
 * Duplication / drift across rules in DIFFERENT surfaces, via normalized
 * 5-gram shingles + Jaccard:
 *   J >= 0.9        -> duplication (error when the surfaces feed different tools)
 *   0.6 <= J < 0.9  -> drift ("started identical and diverged" — evidence shows the diff)
 *
 * Pairwise O(n^2) with set-intersection cost per pair — fine for n <= maxRules;
 * above that we bail gracefully with an info finding.
 */
export function analyzeDuplication(
  rules: Rule[],
  surfaces: Map<string, Surface>,
  maxRules: number,
): Finding[] {
  if (rules.length > maxRules) {
    return [
      {
        ruleIds: [],
        surfaceIds: [],
        severity: "info",
        category: "duplication",
        message: `Skipped duplication analysis: ${rules.length} rules exceeds the ${maxRules}-rule cap (pairwise comparison would be too slow). Raise analysis.maxRules in ctxlint.config.json if you really want it.`,
        evidence: `${rules.length} rules`,
      },
    ];
  }

  const prepared: Prepared[] = rules
    .map((rule) => {
      const words = normalizeWords(rule.text);
      return { rule, words, shingleSet: shingles(words) };
    })
    .filter((p) => p.words.length >= 4);

  const findings: Finding[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i] as Prepared;
      const b = prepared[j] as Prepared;
      if (a.rule.surfaceId === b.rule.surfaceId) continue;
      const similarity = jaccard(a.shingleSet, b.shingleSet);
      if (similarity < DRIFT_THRESHOLD) continue;

      const surfaceA = surfaces.get(a.rule.surfaceId);
      const surfaceB = surfaces.get(b.rule.surfaceId);
      const locA = location(a.rule, surfaces);
      const locB = location(b.rule, surfaces);

      if (similarity >= DUPLICATION_THRESHOLD) {
        const crossTool = differentTools(surfaceA, surfaceB);
        findings.push({
          ruleIds: [a.rule.id, b.rule.id],
          surfaceIds: [a.rule.surfaceId, b.rule.surfaceId],
          severity: crossTool ? "error" : "warn",
          category: "duplication",
          message: crossTool
            ? `Same rule maintained twice for different tools: ${locA} and ${locB} are ${Math.round(similarity * 100)}% identical. Keep one canonical copy (prefer AGENTS.md) and delete the other.`
            : `Duplicate rule: ${locA} and ${locB} are ${Math.round(similarity * 100)}% identical. Delete one copy.`,
          evidence: `A: "${quote(a.rule.text)}"\nB: "${quote(b.rule.text)}"`,
          fix: {
            kind: "delete-rule",
            description: `Delete the non-canonical copy; keep the one in the higher-ranking surface.`,
          },
        });
      } else {
        findings.push({
          ruleIds: [a.rule.id, b.rule.id],
          surfaceIds: [a.rule.surfaceId, b.rule.surfaceId],
          severity: "warn",
          category: "drift",
          message: `These rules started identical and diverged (${Math.round(similarity * 100)}% similar): ${locA} vs ${locB}. Decide which is right and align them.`,
          evidence: `diff: ${diffWords(a.words, b.words)}`,
          fix: {
            kind: "merge-rules",
            description: "Reconcile the two versions into one and reference it from both surfaces.",
          },
        });
      }
    }
  }
  return findings;
}
