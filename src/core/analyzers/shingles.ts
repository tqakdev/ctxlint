/**
 * Text-similarity primitives shared by the duplication/drift/contradiction
 * analyzers. Shingling works on any script (it is whitespace/word based);
 * only the polarity heuristics in contradiction.ts are English-specific.
 */

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/`/g, " ")
    .replace(/[^\p{L}\p{N}/*.@-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w !== "");
}

export function shingles(words: readonly string[], n = 5): Set<string> {
  if (words.length === 0) return new Set();
  if (words.length <= n) return new Set([words.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Compact word-level LCS diff: "... [-old-] {+new+} ..." with context. */
export function diffWords(a: readonly string[], b: readonly string[]): string {
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const below = lcs[i + 1] as number[];
    for (let j = n - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const at = (i: number, j: number): number => (lcs[i] as number[])[j] as number;
  const parts: { kind: "same" | "del" | "add"; word: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      parts.push({ kind: "same", word: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      parts.push({ kind: "del", word: a[i] as string });
      i++;
    } else {
      parts.push({ kind: "add", word: b[j] as string });
      j++;
    }
  }
  while (i < m) parts.push({ kind: "del", word: a[i++] as string });
  while (j < n) parts.push({ kind: "add", word: b[j++] as string });

  // Render changed hunks with two words of context on each side.
  const keep = new Array<boolean>(parts.length).fill(false);
  parts.forEach((part, idx) => {
    if (part.kind === "same") return;
    for (let k = Math.max(0, idx - 2); k <= Math.min(parts.length - 1, idx + 2); k++)
      keep[k] = true;
  });
  const pieces: string[] = [];
  let skipping = false;
  for (let k = 0; k < parts.length; k++) {
    if (!keep[k]) {
      if (!skipping) pieces.push("…");
      skipping = true;
      continue;
    }
    skipping = false;
    const part = parts[k] as { kind: string; word: string };
    if (part.kind === "same") pieces.push(part.word);
    else if (part.kind === "del") pieces.push(`[-${part.word}-]`);
    else pieces.push(`{+${part.word}+}`);
  }
  return pieces.join(" ");
}
