import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runScan } from "../core/pipeline.js";
import { editsByFile, type FixPlan, planFixes } from "../fix/planner.js";
import {
  applyEditsToContent,
  buildRenameMap,
  checkCleanTree,
  renderFixesMarkdown,
  unifiedDiff,
} from "../fix/writer.js";

export interface FixCliOptions {
  write?: boolean;
}

export interface FixOutcome {
  plan: FixPlan;
  scoreBefore: number;
  scoreAfter?: number;
  applied: string[];
  refused?: string;
  fixesFile: string;
  diffs: string[];
}

/** Core fix flow, callable from tests without going through the CLI. */
export async function runFix(
  root: string,
  options: { write: boolean; userGlobalDir?: string | null },
): Promise<FixOutcome> {
  const config = await loadConfig(root);
  const before = await runScan({
    root,
    config,
    userGlobalDir: options.userGlobalDir ?? path.join(os.homedir(), ".claude"),
  });

  const renames = await buildRenameMap(root);
  const plan = planFixes(before, renames);
  const fixesFile = path.join(root, "ctxlint-fixes.md");
  const outcome: FixOutcome = {
    plan,
    scoreBefore: before.score.total,
    applied: [],
    fixesFile,
    diffs: [],
  };

  if (options.write) {
    const tree = await checkCleanTree(root);
    if (!tree.clean) {
      outcome.refused = tree.reason;
      return outcome;
    }
    for (const [file, edits] of editsByFile(plan)) {
      const absolute = path.join(root, file);
      const content = await readFile(absolute, "utf8");
      const next = applyEditsToContent(content, edits);
      if (next !== content) {
        outcome.diffs.push(unifiedDiff(file, content, next));
        await writeFile(absolute, next, "utf8");
        outcome.applied.push(file);
      }
    }
    const after = await runScan({
      root,
      config,
      userGlobalDir: options.userGlobalDir ?? path.join(os.homedir(), ".claude"),
    });
    outcome.scoreAfter = after.score.total;
  }

  await writeFile(fixesFile, renderFixesMarkdown(plan, before.score.total, root), "utf8");
  return outcome;
}

export async function fixCommand(
  targetPath: string | undefined,
  options: FixCliOptions,
): Promise<void> {
  const root = path.resolve(targetPath ?? ".");
  const outcome = await runFix(root, { write: options.write ?? false });

  const safe = outcome.plan.fixes.filter((f) => f.safe).length;
  const suggestions = outcome.plan.fixes.length - safe;

  if (outcome.refused) {
    process.stderr.write(
      `ctxlint: refusing to --write: ${outcome.refused}\nCommit or stash first, then re-run.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `ctxlint fix: ${safe} safe fix(es), ${suggestions} suggestion(s) — plan written to ${outcome.fixesFile}\n`,
  );
  if (options.write) {
    if (outcome.applied.length === 0) {
      process.stdout.write("Nothing safely auto-fixable — see the suggestions in the plan.\n");
    } else {
      process.stdout.write(`Applied safe fixes to: ${outcome.applied.join(", ")}\n`);
      process.stdout.write(
        `Context Health Score: ${outcome.scoreBefore} -> ${outcome.scoreAfter} (re-scan)\n`,
      );
    }
  } else if (safe > 0) {
    process.stdout.write(
      "Run `ctxlint fix --write` to apply the safe fixes (clean git tree required).\n",
    );
  }
}
