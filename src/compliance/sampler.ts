import { createHash } from "node:crypto";
import { execa } from "execa";
import { estimateTokens } from "../core/tokens.js";

export interface DiffChunk {
  /** Stable hash of the chunk's diff text. */
  id: string;
  /** Commit the chunk came from. */
  sha: string;
  files: string[];
  diff: string;
  tokensEstimated: number;
}

export interface SampleResult {
  chunks: DiffChunk[];
  commitsSampled: number;
  usedMerges: boolean;
}

export type SampleError = { error: string };

/** Paths whose diffs are noise for rule compliance. */
const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|go\.sum)$|(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|__generated__)\/|\.(min\.js|map|snap|lock)$/;

export const MAX_CHUNK_TOKENS = 4000;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: root });
  return stdout;
}

interface FileDiff {
  file: string;
  text: string;
}

/** Split a unified diff into per-file segments. */
export function splitDiffByFile(diff: string): FileDiff[] {
  const segments: FileDiff[] = [];
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  for (const part of parts) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const file = header?.[2] ?? header?.[1] ?? "unknown";
    segments.push({ file, text: part });
  }
  return segments;
}

/** Greedy-pack per-file diffs into chunks of at most maxTokens each. */
export function chunkFileDiffs(sha: string, fileDiffs: FileDiff[], maxTokens: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let files: string[] = [];
  let parts: string[] = [];
  let tokens = 0;

  const flush = () => {
    if (parts.length === 0) return;
    const diff = parts.join("");
    chunks.push({
      id: createHash("sha1").update(diff).digest("hex").slice(0, 12),
      sha,
      files: [...files],
      diff,
      tokensEstimated: tokens,
    });
    files = [];
    parts = [];
    tokens = 0;
  };

  for (const fileDiff of fileDiffs) {
    let text = fileDiff.text;
    let cost = estimateTokens(text);
    if (cost > maxTokens) {
      // One enormous file diff — keep the head, note the truncation.
      const lines = text.split("\n");
      const keep = Math.max(20, Math.floor(lines.length * (maxTokens / cost)));
      text = `${lines.slice(0, keep).join("\n")}\n… (diff truncated by ctxlint at ~${maxTokens} tokens)\n`;
      cost = estimateTokens(text);
    }
    if (tokens + cost > maxTokens) flush();
    files.push(fileDiff.file);
    parts.push(text);
    tokens += cost;
  }
  flush();
  return chunks;
}

/**
 * Sample the last N merged changes (falling back to plain commits when the
 * history has no merges), returning judgeable diff chunks.
 */
export async function sampleCommits(
  root: string,
  count: number,
  maxChunkTokens = MAX_CHUNK_TOKENS,
): Promise<SampleResult | SampleError> {
  let shas: string[];
  let usedMerges = true;
  try {
    const merges = await git(root, ["log", "--merges", "-n", String(count), "--format=%H"]);
    shas = merges.split("\n").filter((s) => s !== "");
    if (shas.length === 0) {
      usedMerges = false;
      const plain = await git(root, ["log", "-n", String(count), "--format=%H"]);
      shas = plain.split("\n").filter((s) => s !== "");
    }
  } catch {
    return { error: "not a git repository (or git is unavailable)" };
  }
  if (shas.length === 0) {
    return { error: "the repository has no commits to sample" };
  }

  const chunks: DiffChunk[] = [];
  for (const sha of shas) {
    let diff: string;
    try {
      // -m --first-parent: for merges, show the change the merge actually
      // landed (vs first parent); harmless for plain commits.
      diff = await git(root, ["show", sha, "--format=", "--patch", "-m", "--first-parent", "--no-color"]);
    } catch {
      continue;
    }
    const fileDiffs = splitDiffByFile(diff).filter((f) => !SKIP_FILE.test(f.file));
    chunks.push(...chunkFileDiffs(sha, fileDiffs, maxChunkTokens));
  }

  return { chunks, commitsSampled: shas.length, usedMerges };
}
