import type { Finding, Rule, Surface } from "../model.js";
import { jaccard, normalizeWords, shingles } from "./shingles.js";

/**
 * Heuristic-tier contradiction detection (LLM-tier belongs to the compliance
 * module). Detects polarity flips — always/never, do/don't — between sentences
 * whose depolarized content shares an object (>= 2 shared content bigrams).
 *
 * NOTE ON THRESHOLDS: the spec sketches "similarity 0.5–0.9" as the pair
 * prefilter, but real contradictions ("Always use named exports" vs "Never use
 * named exports for components") share almost no 5-gram shingles, so a 0.5
 * shingle-Jaccard floor filters out exactly the pairs we want. We instead
 * prefilter on shared content bigrams and keep the 0.9 ceiling (above it the
 * pair is a duplication, not a contradiction).
 *
 * The polarity vocabulary is ENGLISH-ONLY; reports must say so.
 */

const NEGATIVE = /\b(?:never|don'?t|do not|avoid|must not|no)\b/i;
const POSITIVE = /\b(?:always|must|prefer|use|do)\b/i;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "of",
  "for",
  "to",
  "and",
  "or",
  "so",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "is",
  "are",
  "be",
  "with",
  "as",
  "at",
  "by",
  "from",
  "into",
  "your",
  "our",
  "we",
  "you",
  "they",
  "them",
  "anywhere",
  "everywhere",
  "here",
  "there",
]);

const POLARITY_WORDS = new Set([
  "always",
  "never",
  "must",
  "not",
  "don't",
  "dont",
  "do",
  "avoid",
  "no",
  "prefer",
]);

type Polarity = "positive" | "negative" | "none";

export function sentencePolarity(sentence: string): Polarity {
  if (NEGATIVE.test(sentence)) return "negative";
  if (POSITIVE.test(sentence)) return "positive";
  return "none";
}

function contentBigrams(words: readonly string[]): Set<string> {
  const filtered = words.filter((w) => !STOPWORDS.has(w) && !POLARITY_WORDS.has(w));
  const out = new Set<string>();
  for (let i = 0; i + 2 <= filtered.length; i++) {
    out.add(`${filtered[i]} ${filtered[i + 1]}`);
  }
  return out;
}

/**
 * The "directive core": the polarity word and the ~8 words after it — the
 * object the instruction is actually about. Requiring the shared bigrams to
 * come from both cores (not anywhere in the sentence) is what separates
 * "Always use named exports" vs "Never use named exports for components"
 * from two sentences that merely mention the same noun in different clauses.
 */
function directiveCore(sentence: string): Set<string> {
  const marker = new RegExp(`${NEGATIVE.source}|${POSITIVE.source}`, "i").exec(sentence);
  if (!marker) return new Set();
  const words = normalizeWords(sentence.slice(marker.index)).slice(0, 9);
  return contentBigrams(words);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface PreparedSentence {
  sentence: string;
  polarity: Polarity;
  bigrams: Set<string>;
}

function location(rule: Rule, surfaces: Map<string, Surface>): string {
  const surfacePath = surfaces.get(rule.surfaceId)?.path ?? rule.surfaceId;
  return `${surfacePath}:${rule.span.startLine}-${rule.span.endLine}`;
}

export function analyzeContradiction(
  rules: Rule[],
  surfaces: Map<string, Surface>,
  maxRules: number,
): Finding[] {
  if (rules.length > maxRules) return [];

  // Rules with no polarity-bearing sentence can never contradict anything —
  // drop them before the O(n²) pair loop (and before shingling, which is the
  // expensive part).
  const prepared = rules
    .map((rule) => ({
      rule,
      sentences: splitSentences(rule.text)
        .map(
          (sentence): PreparedSentence => ({
            sentence,
            polarity: sentencePolarity(sentence),
            bigrams: directiveCore(sentence),
          }),
        )
        .filter((s) => s.polarity !== "none" && s.bigrams.size > 0),
    }))
    .filter((p) => p.sentences.length > 0)
    .map((p) => ({ ...p, ruleShingles: shingles(normalizeWords(p.rule.text)) }));

  const findings: Finding[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i] as (typeof prepared)[number];
      const b = prepared[j] as (typeof prepared)[number];
      if (a.rule.id === b.rule.id) continue;
      // Near-duplicates are duplication findings, not contradictions.
      if (jaccard(a.ruleShingles, b.ruleShingles) >= 0.9) continue;

      for (const sa of a.sentences) {
        for (const sb of b.sentences) {
          if (sa.polarity === sb.polarity) continue;
          let shared = 0;
          for (const bigram of sa.bigrams) {
            if (sb.bigrams.has(bigram)) shared += 1;
          }
          if (shared < 2) continue;

          const pairKey = [a.rule.id, b.rule.id].sort().join("|");
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          findings.push({
            ruleIds: [a.rule.id, b.rule.id],
            surfaceIds: [...new Set([a.rule.surfaceId, b.rule.surfaceId])],
            severity: "warn",
            category: "contradiction",
            message: `Contradictory instructions about the same thing: ${location(a.rule, surfaces)} says one polarity, ${location(b.rule, surfaces)} the opposite. An agent reading both will follow whichever it saw last — pick one. (Polarity heuristic is English-only.)`,
            evidence: `A: "${sa.sentence}"\nB: "${sb.sentence}"`,
            fix: {
              kind: "rewrite",
              description:
                "Decide which instruction is correct, delete the other, and scope the survivor explicitly (e.g. per file type) if both were partially right.",
            },
          });
        }
      }
    }
  }
  return findings;
}
