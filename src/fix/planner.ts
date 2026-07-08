import { normalizeWords } from "../core/analyzers/shingles.js";
import type { Finding, FixKind, Rule, Surface, SurfaceKind } from "../core/model.js";
import type { ScanResult } from "../core/pipeline.js";

/**
 * Fix planning is pure: it turns scan findings into concrete span edits plus
 * judgment-requiring suggestions. Only three fix shapes are SAFE (applied by
 * `fix --write`):
 *
 *   1. delete exact duplicates, keeping the copy in the highest-ranking
 *      surface (AGENTS.md > CLAUDE.md > copilot > cursor rule > skill > other);
 *   2. update stale paths when git history shows a unique rename target;
 *   3. move buried critical rules to the front — only when the author
 *      emphasized them in CAPITALS (NEVER/MUST/ALWAYS/DO NOT), because moving
 *      a lowercase "should" out of its section is a judgment call.
 *
 * Everything else stays a suggestion in ctxlint-fixes.md.
 */

export interface SpanEdit {
  file: string;
  type: "delete" | "replace" | "move-to-top";
  span: { startLine: number; endLine: number };
  find?: string;
  replaceWith?: string;
}

export interface PlannedFix {
  kind: FixKind;
  safe: boolean;
  description: string;
  findingMessage: string;
  evidence: string;
  edits: SpanEdit[];
}

export interface FixPlan {
  fixes: PlannedFix[];
}

const KIND_RANK: Record<SurfaceKind, number> = {
  "agents-md": 0,
  "claude-md": 1,
  "copilot-instructions": 2,
  "cursor-rule": 3,
  "windsurf-rule": 4,
  skill: 5,
  other: 6,
};

const AUTHOR_EMPHASIZED = /\b(?:NEVER|MUST(?: NOT)?|ALWAYS|DO NOT)\b/;

function normalizedText(rule: Rule): string {
  return normalizeWords(rule.text).join(" ");
}

/** The surface whose copy we keep; the other one loses its copy. */
function pickLoser(a: { rule: Rule; surface: Surface }, b: { rule: Rule; surface: Surface }) {
  const rankA = KIND_RANK[a.surface.kind];
  const rankB = KIND_RANK[b.surface.kind];
  if (rankA !== rankB) return rankA > rankB ? a : b;
  return a.surface.path > b.surface.path ? a : b;
}

export function planFixes(result: ScanResult, renames: Map<string, string[]>): FixPlan {
  const rulesById = new Map(result.rules.map((r) => [r.id, r]));
  const surfacesById = new Map(result.surfaces.map((s) => [s.id, s]));
  const fixes: PlannedFix[] = [];
  const plannedDeletes = new Set<string>();
  const plannedUpdates = new Set<string>();

  const lookup = (ruleId: string) => {
    const rule = rulesById.get(ruleId);
    const surface = rule ? surfacesById.get(rule.surfaceId) : undefined;
    return rule && surface && surface.scope !== "user-global" ? { rule, surface } : undefined;
  };

  const suggest = (finding: Finding, kind: FixKind, description: string) => {
    fixes.push({
      kind,
      safe: false,
      description,
      findingMessage: finding.message,
      evidence: finding.evidence,
      edits: [],
    });
  };

  for (const finding of result.findings) {
    switch (finding.category) {
      case "duplication": {
        const a = finding.ruleIds[0] ? lookup(finding.ruleIds[0]) : undefined;
        const b = finding.ruleIds[1] ? lookup(finding.ruleIds[1]) : undefined;
        if (!a || !b) break;
        if (normalizedText(a.rule) !== normalizedText(b.rule)) {
          suggest(
            finding,
            "merge-rules",
            "Near-identical but not byte-equal — merge by hand so no nuance is lost.",
          );
          break;
        }
        const loser = pickLoser(a, b);
        const winner = loser === a ? b : a;
        const key = `${loser.surface.path}:${loser.rule.span.startLine}-${loser.rule.span.endLine}`;
        if (plannedDeletes.has(key)) break;
        plannedDeletes.add(key);
        fixes.push({
          kind: "delete-rule",
          safe: true,
          description: `Delete the copy in ${loser.surface.path} (lines ${loser.rule.span.startLine}-${loser.rule.span.endLine}); the canonical copy lives in ${winner.surface.path}:${winner.rule.span.startLine}.`,
          findingMessage: finding.message,
          evidence: finding.evidence,
          edits: [{ file: loser.surface.path, type: "delete", span: loser.rule.span }],
        });
        break;
      }

      case "stale-reference": {
        const target = finding.ruleIds[0] ? lookup(finding.ruleIds[0]) : undefined;
        if (!target) break;
        // Only the reference this finding is about may be rewritten — the
        // rule's other paths are live and touching them corrupts the file.
        const staleRef = finding.fix?.ref?.replace(/\/$/, "");
        const candidates = staleRef !== undefined ? renames.get(staleRef) : undefined;
        const newPath = candidates?.length === 1 ? (candidates[0] as string) : undefined;
        // `git log --all` sees abandoned branches, so a unique rename target
        // may itself be gone — never write a path that does not exist today.
        const targetExists =
          newPath !== undefined &&
          (result.index.fileSet.has(newPath) || result.index.dirSet.has(newPath));
        if (staleRef !== undefined && newPath !== undefined && targetExists) {
          const key = `${target.surface.path}:${target.rule.span.startLine}:${staleRef}->${newPath}`;
          if (plannedUpdates.has(key)) break;
          plannedUpdates.add(key);
          fixes.push({
            kind: "update-path",
            safe: true,
            description: `git history shows \`${staleRef}\` was renamed to \`${newPath}\` — update the reference in ${target.surface.path}:${target.rule.span.startLine}.`,
            findingMessage: finding.message,
            evidence: finding.evidence,
            edits: [
              {
                file: target.surface.path,
                type: "replace",
                span: target.rule.span,
                find: staleRef,
                replaceWith: newPath,
              },
            ],
          });
        } else {
          suggest(
            finding,
            "update-path",
            "No unique surviving rename target in git history — fix the path by hand or delete the rule.",
          );
        }
        break;
      }

      case "budget": {
        if (finding.fix?.kind === "move-to-front") {
          const buried = finding.ruleIds
            .map(lookup)
            .filter((x): x is NonNullable<typeof x> => x !== undefined);
          const emphasized = buried.filter((x) => AUTHOR_EMPHASIZED.test(x.rule.text));
          for (const { rule, surface } of emphasized) {
            fixes.push({
              kind: "move-to-front",
              safe: true,
              description: `Move the author-emphasized rule at ${surface.path}:${rule.span.startLine}-${rule.span.endLine} into a "Critical rules" section at the top.`,
              findingMessage: finding.message,
              evidence: `"${rule.text.slice(0, 160)}"`,
              edits: [{ file: surface.path, type: "move-to-top", span: rule.span }],
            });
          }
          const rest = buried.length - emphasized.length;
          if (rest > 0) {
            suggest(
              finding,
              "move-to-front",
              `${rest} more buried critical rule(s) were left in place (not CAPITALIZED by the author — moving them is a judgment call). Review and reorder by hand.`,
            );
          }
        } else if (finding.fix?.kind === "split-file") {
          suggest(finding, "split-file", finding.fix.description);
        }
        break;
      }

      case "drift":
        suggest(
          finding,
          "merge-rules",
          "Two diverged copies of the same rule — decide which is right, then keep one copy (ideally in AGENTS.md).",
        );
        break;

      case "contradiction":
        suggest(
          finding,
          "rewrite",
          finding.fix?.description ?? "Resolve the contradiction by hand.",
        );
        break;

      case "structure":
        if (finding.fix) suggest(finding, finding.fix.kind, finding.fix.description);
        break;

      default:
        break;
    }
  }

  return { fixes };
}

/** Group edits by file, ready for the writer. */
export function editsByFile(plan: FixPlan): Map<string, SpanEdit[]> {
  const out = new Map<string, SpanEdit[]>();
  for (const fix of plan.fixes) {
    if (!fix.safe) continue;
    for (const edit of fix.edits) {
      const list = out.get(edit.file) ?? [];
      list.push(edit);
      out.set(edit.file, list);
    }
  }
  return out;
}
