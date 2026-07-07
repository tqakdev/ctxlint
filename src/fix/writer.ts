import { execa } from "execa";
import type { FixPlan, SpanEdit } from "./planner.js";

/** old repo-relative path -> distinct rename targets seen in git history. */
export async function buildRenameMap(root: string): Promise<Map<string, string[]>> {
  try {
    const { stdout } = await execa(
      "git",
      ["log", "--all", "--diff-filter=R", "--name-status", "--format="],
      { cwd: root },
    );
    const map = new Map<string, Set<string>>();
    for (const line of stdout.split("\n")) {
      const match = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
      if (!match) continue;
      const [, oldPath, newPath] = match as unknown as [string, string, string];
      const set = map.get(oldPath) ?? new Set<string>();
      set.add(newPath);
      map.set(oldPath, set);
    }
    return new Map([...map].map(([k, v]) => [k, [...v].sort()]));
  } catch {
    return new Map();
  }
}

export interface TreeState {
  clean: boolean;
  reason?: string;
}

/** ctxlint's own outputs: changes to these must not block `fix --write`. */
function isOwnArtifact(porcelainLine: string): boolean {
  // Porcelain v1: two status chars + space, then the path ("old -> new" for renames).
  const p = porcelainLine.slice(3);
  return p === "ctxlint-fixes.md" || p.startsWith(".ctxlint-cache/");
}

/** `fix --write` requires a git repo with no modified tracked files. */
export async function checkCleanTree(root: string): Promise<TreeState> {
  try {
    const { stdout } = await execa("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
    });
    const dirty = stdout.split("\n").filter((line) => line.trim() !== "" && !isOwnArtifact(line));
    if (dirty.length > 0) {
      return {
        clean: false,
        reason: `uncommitted changes to tracked files:\n${dirty.join("\n")}`,
      };
    }
    return { clean: true };
  } catch {
    return {
      clean: false,
      reason:
        "not a git repository — --write needs git so every change is reviewable and revertable",
    };
  }
}

const CRITICAL_HEADING = "## Critical rules";

/**
 * Replace `find` only where it stands alone as a path — not embedded in a
 * longer path token (`src/utils.ts` inside `src/utils.ts.orig` or
 * `vendor/src/utils.ts` must survive a rename of `src/utils.ts`).
 */
function replaceStandalonePath(line: string, find: string, replaceWith: string): string {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = /[\w@./-]/.source;
  const re = new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`, "g");
  return line.replace(re, () => replaceWith);
}

/**
 * Apply span edits to one file's content. Deterministic and pure:
 * replacements first (in place), then deletions bottom-up, then moved rules
 * inserted under a "Critical rules" section after the first H1.
 */
export function applyEditsToContent(content: string, edits: SpanEdit[]): string {
  let lines = content.split("\n");

  for (const edit of edits) {
    if (edit.type !== "replace" || !edit.find || edit.replaceWith === undefined) continue;
    for (let i = edit.span.startLine - 1; i <= edit.span.endLine - 1 && i < lines.length; i++) {
      lines[i] = replaceStandalonePath(lines[i] as string, edit.find, edit.replaceWith);
    }
  }

  const moved: string[] = [];
  const spansToDelete: { startLine: number; endLine: number }[] = [];
  for (const edit of edits) {
    if (edit.type === "move-to-top") {
      moved.push(...lines.slice(edit.span.startLine - 1, edit.span.endLine));
      spansToDelete.push(edit.span);
    } else if (edit.type === "delete") {
      spansToDelete.push(edit.span);
    }
  }

  spansToDelete.sort((a, b) => b.startLine - a.startLine);
  for (const span of spansToDelete) {
    lines.splice(span.startLine - 1, span.endLine - span.startLine + 1);
  }

  if (moved.length > 0) {
    const existing = lines.findIndex((l) => l.trim() === CRITICAL_HEADING);
    if (existing !== -1) {
      lines.splice(existing + 1, 0, "", ...moved);
    } else {
      const h1 = lines.findIndex((l) => /^#\s/.test(l));
      const insertAt = h1 === -1 ? 0 : h1 + 1;
      lines.splice(insertAt, 0, "", CRITICAL_HEADING, "", ...moved);
    }
  }

  // Collapse blank runs left behind by deletions — but never inside fenced
  // code blocks, where blank lines are content, not formatting.
  const collapsed: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "" && collapsed[collapsed.length - 1]?.trim() === "") continue;
    collapsed.push(line);
  }
  lines = collapsed;
  return lines.join("\n");
}

/** Minimal unified diff between two file versions, for fix previews. */
export function unifiedDiff(file: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  // Simple LCS-free hunking is enough here: emit one hunk over the changed range.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  if (start > a.length - 1 && start > b.length - 1) return `${out.join("\n")}\n(no changes)`;
  out.push(
    `@@ -${start + 1},${Math.max(0, endA - start + 1)} +${start + 1},${Math.max(0, endB - start + 1)} @@`,
  );
  for (let i = start; i <= endA; i++) out.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+${b[i]}`);
  return out.join("\n");
}

export function renderFixesMarkdown(
  plan: FixPlan,
  scoreBefore: number,
  root: string,
  generatedAt = new Date(),
): string {
  const safe = plan.fixes.filter((f) => f.safe);
  const suggestions = plan.fixes.filter((f) => !f.safe);
  const lines: string[] = [];
  lines.push("# ctxlint fix plan");
  lines.push("");
  lines.push(`Scanned \`${root}\` — Context Health Score ${scoreBefore}/100.`);
  lines.push("");
  lines.push(
    `**${safe.length} safe fix(es)** (applied by \`ctxlint fix --write\`) and **${suggestions.length} suggestion(s)** that need your judgment.`,
  );
  lines.push("");

  if (safe.length > 0) {
    lines.push("## Safe fixes (auto-applicable)");
    lines.push("");
    for (const fix of safe) {
      lines.push(`### ${fix.kind}: ${fix.description}`);
      lines.push("");
      lines.push(`- finding: ${fix.findingMessage}`);
      lines.push("");
    }
  }

  if (suggestions.length > 0) {
    lines.push("## Suggestions (review by hand)");
    lines.push("");
    for (const fix of suggestions) {
      lines.push(`### ${fix.kind}: ${fix.description}`);
      lines.push("");
      lines.push(`- finding: ${fix.findingMessage}`);
      for (const evidenceLine of fix.evidence.split("\n")) {
        lines.push(`  > ${evidenceLine}`);
      }
      lines.push("");
    }
  }

  lines.push(`*Generated by ctxlint at ${generatedAt.toISOString()}.*`);
  lines.push("");
  return lines.join("\n");
}
