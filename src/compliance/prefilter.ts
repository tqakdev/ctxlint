import { normalizeWords } from "../core/analyzers/shingles.js";
import { globToRegExp } from "../core/glob.js";
import type { Rule } from "../core/model.js";
import type { DiffChunk } from "./sampler.js";

/**
 * Cheap applicability prefilter: a (rule, chunk) pair is judged only when the
 * rule plausibly applies to the change — shared file/glob overlap or enough
 * distinctive-keyword overlap. This keeps the judged pair count (and spend)
 * proportional to genuine matches instead of |rules| x |chunks|.
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "do",
  "not",
  "don't",
  "never",
  "always",
  "must",
  "should",
  "use",
  "when",
  "before",
  "after",
  "into",
  "from",
  "them",
  "they",
  "your",
  "our",
  "you",
  "we",
  "as",
  "at",
  "by",
  "if",
  "any",
  "all",
  "one",
  "two",
  "here",
  "there",
  "was",
  "were",
]);

export interface PreparedChunk {
  chunk: DiffChunk;
  words: Set<string>;
}

export function prepareChunk(chunk: DiffChunk): PreparedChunk {
  return { chunk, words: new Set(normalizeWords(chunk.diff)) };
}

export interface PreparedRule {
  rule: Rule;
  keywords: string[];
  pathRefs: string[];
  globRefs: RegExp[];
}

export function prepareRule(rule: Rule): PreparedRule {
  const keywords = [
    ...new Set(normalizeWords(rule.text).filter((w) => w.length >= 4 && !STOPWORDS.has(w))),
  ];
  const pathRefs: string[] = [];
  const globRefs: RegExp[] = [];
  for (const ref of rule.referencedPaths) {
    if (ref.startsWith("npm run ")) continue;
    if (ref.includes("*") || ref.includes("?")) globRefs.push(globToRegExp(ref));
    else pathRefs.push(ref.replace(/\/$/, ""));
  }
  return { rule, keywords, pathRefs, globRefs };
}

export const KEYWORD_OVERLAP_MIN = 2;

export function ruleApplies(rule: PreparedRule, chunk: PreparedChunk): boolean {
  for (const file of chunk.chunk.files) {
    for (const ref of rule.pathRefs) {
      if (file === ref || file.startsWith(`${ref}/`)) return true;
    }
    for (const glob of rule.globRefs) {
      if (glob.test(file)) return true;
    }
  }
  let overlap = 0;
  for (const keyword of rule.keywords) {
    if (chunk.words.has(keyword)) {
      overlap += 1;
      if (overlap >= KEYWORD_OVERLAP_MIN) return true;
    }
  }
  return false;
}
