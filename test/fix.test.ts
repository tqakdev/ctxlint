import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { normalizeWords } from "../src/core/analyzers/shingles.js";
import { runScan } from "../src/core/pipeline.js";
import { runFix } from "../src/commands/fix.js";
import { planFixes } from "../src/fix/planner.js";
import { applyEditsToContent } from "../src/fix/writer.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

async function tempGitRepoFromMessy(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-fix-"));
  await cp(path.join(fixtures, "messy-repo"), dir, { recursive: true });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "initial");
  return dir;
}

describe("fix planner", () => {
  it("deletes exact duplicates only from the lower-ranked surface", async () => {
    const result = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
    const plan = planFixes(result, new Map());
    const deletes = plan.fixes.filter((f) => f.safe && f.kind === "delete-rule");
    expect(deletes.length).toBeGreaterThan(0);
    for (const fix of deletes) {
      for (const edit of fix.edits) {
        // CLAUDE.md outranks cursor rules; copilot outranks .cursorrules.
        expect(["CLAUDE.md", ".github/copilot-instructions.md"]).not.toContain(edit.file);
      }
    }
  });

  it("only moves author-CAPITALIZED critical rules; the rest stay suggestions", async () => {
    const result = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
    const plan = planFixes(result, new Map());
    const moves = plan.fixes.filter((f) => f.kind === "move-to-front" && f.safe);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.evidence).toContain("NEVER run");
    expect(
      plan.fixes.some((f) => f.kind === "move-to-front" && !f.safe && /judgment/.test(f.description)),
    ).toBe(true);
  });

  it("plans a path update only when git history has a unique rename target", async () => {
    const result = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
    const unique = new Map([["src/utils/date-helpers.js", ["src/utils/dates.js"]]]);
    const plan = planFixes(result, unique);
    const updates = plan.fixes.filter((f) => f.kind === "update-path" && f.safe);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.edits[0]?.replaceWith).toBe("src/utils/dates.js");

    const ambiguous = new Map([["src/utils/date-helpers.js", ["a.js", "b.js"]]]);
    expect(
      planFixes(result, ambiguous).fixes.filter((f) => f.kind === "update-path" && f.safe),
    ).toHaveLength(0);
  });
});

describe("edit application", () => {
  it("applies delete + move + replace deterministically", () => {
    const content = [
      "# Title",
      "",
      "intro",
      "",
      "- keep me",
      "- delete me",
      "- rename src/old.js here",
      "",
      "- NEVER do the bad thing",
    ].join("\n");
    const next = applyEditsToContent(content, [
      { file: "f", type: "delete", span: { startLine: 6, endLine: 6 } },
      {
        file: "f",
        type: "replace",
        span: { startLine: 7, endLine: 7 },
        find: "src/old.js",
        replaceWith: "src/new.js",
      },
      { file: "f", type: "move-to-top", span: { startLine: 9, endLine: 9 } },
    ]);
    expect(next).toContain("## Critical rules");
    expect(next.indexOf("NEVER do the bad thing")).toBeLessThan(next.indexOf("intro"));
    expect(next).not.toContain("delete me");
    expect(next).toContain("src/new.js");
    expect(next).not.toContain("src/old.js");
  });
});

describe("fix --write end to end (M3 acceptance)", () => {
  it("improves the score on the messy fixture and loses nothing beyond exact dupes", async () => {
    const dir = await tempGitRepoFromMessy();
    const before = await runScan({ root: dir, userGlobalDir: null });

    const outcome = await runFix(dir, { write: true, userGlobalDir: null });
    expect(outcome.refused).toBeUndefined();
    expect(outcome.applied.length).toBeGreaterThan(0);
    expect(outcome.scoreAfter).toBeDefined();
    expect(outcome.scoreAfter as number).toBeGreaterThan(outcome.scoreBefore);

    // Every rule that existed before still exists somewhere after (dupes kept
    // one canonical copy; moved rules moved, not deleted).
    const after = await runScan({ root: dir, userGlobalDir: null });
    const afterTexts = new Set(after.rules.map((r) => normalizeWords(r.text).join(" ")));
    for (const rule of before.rules) {
      expect(afterTexts.has(normalizeWords(rule.text).join(" "))).toBe(true);
    }

    // The moved rule now leads the file.
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude.indexOf("NEVER run `npm run migrate`")).toBeLessThan(
      claude.indexOf("## Project overview"),
    );

    // The plan document exists and is grouped.
    const fixesMd = await readFile(path.join(dir, "ctxlint-fixes.md"), "utf8");
    expect(fixesMd).toContain("## Safe fixes");
    expect(fixesMd).toContain("## Suggestions");
  }, 30000);

  it("refuses to write on a dirty tree and touches nothing", async () => {
    const dir = await tempGitRepoFromMessy();
    await writeFile(path.join(dir, "CLAUDE.md"), "# dirty edit\n", "utf8");
    const dirtyContent = await readFile(path.join(dir, "CLAUDE.md"), "utf8");

    const outcome = await runFix(dir, { write: true, userGlobalDir: null });
    expect(outcome.refused).toContain("uncommitted changes");
    expect(outcome.applied).toEqual([]);
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe(dirtyContent);
  }, 30000);

  it("refuses to write outside a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-nogit-"));
    await cp(path.join(fixtures, "messy-repo"), dir, { recursive: true });
    const outcome = await runFix(dir, { write: true, userGlobalDir: null });
    expect(outcome.refused).toContain("not a git repository");
  }, 30000);

  it("updates a stale path when git history shows a unique rename", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-rename-"));
    await mkdir(path.join(dir, "lib"), { recursive: true });
    await writeFile(path.join(dir, "lib/old.js"), "module.exports = 1;\n", "utf8");
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      "# app\n\n- Shared helpers live in `lib/old.js`; import from there.\n",
      "utf8",
    );
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "user.name", "test");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "initial");
    await git(dir, "mv", "lib/old.js", "lib/new.js");
    await git(dir, "commit", "-qm", "rename");

    const outcome = await runFix(dir, { write: true, userGlobalDir: null });
    expect(outcome.refused).toBeUndefined();
    expect(outcome.applied).toContain("CLAUDE.md");
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("lib/new.js");
    expect(claude).not.toContain("lib/old.js");

    const rescan = await runScan({ root: dir, userGlobalDir: null });
    expect(rescan.findings.filter((f) => f.category === "stale-reference")).toEqual([]);
  }, 30000);
});
