import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffWords, jaccard, normalizeWords, shingles } from "../src/core/analyzers/shingles.js";
import { globMatchesAny, globToRegExp } from "../src/core/glob.js";
import type { Finding } from "../src/core/model.js";
import { runScan, type ScanResult } from "../src/core/pipeline.js";
import { scoreFindings } from "../src/core/scoring.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let messyCache: ScanResult | undefined;
async function messy(): Promise<ScanResult> {
  messyCache ??= await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
  return messyCache;
}

function ofCategory(result: ScanResult, category: Finding["category"]): Finding[] {
  return result.findings.filter((f) => f.category === category);
}

describe("M2 acceptance: messy-repo triggers every static finding category", () => {
  it("duplication: verbatim rule across CLAUDE.md and style.mdc is an error naming both files", async () => {
    const findings = ofCategory(await messy(), "duplication");
    expect(findings.length).toBeGreaterThan(0);
    const validation = findings.find((f) => f.evidence.includes("must validate request bodies"));
    expect(validation?.severity).toBe("error");
    expect(validation?.message).toContain(".cursor/rules/style.mdc");
    expect(validation?.message).toContain("CLAUDE.md");
    expect(validation?.message).toMatch(/maintained twice/);
  });

  it("drift: the one-word-diverged workflow rule lands between 60% and 90% with a diff", async () => {
    const findings = ofCategory(await messy(), "drift");
    expect(findings).toHaveLength(1);
    const drift = findings[0] as Finding;
    expect(drift.severity).toBe("warn");
    expect(drift.message).toMatch(/(6[0-9]|7[0-9]|8[0-9])% similar/);
    expect(drift.evidence).toContain("[-");
    expect(drift.evidence).toContain("{+");
    expect(drift.evidence).toMatch(/main|develop/);
  });

  it("contradiction: the named-exports polarity flip is caught with both quotes", async () => {
    const findings = ofCategory(await messy(), "contradiction");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of findings) {
      expect(finding.evidence).toMatch(/exports/i);
      expect(finding.message).toContain("English-only");
    }
    // The canary-window/migration pair must NOT fire (different clauses).
    expect(findings.some((f) => f.evidence.includes("canary window"))).toBe(false);
  });

  it("stale-reference: every planted missing path/script is an error; prose slashes are not", async () => {
    const findings = ofCategory(await messy(), "stale-reference");
    const messages = findings.map((f) => f.message).join("\n");
    expect(messages).toContain("src/api/v1/");
    expect(messages).toContain("docs/architecture.md");
    expect(messages).toContain("src/utils/date-helpers.js");
    expect(messages).toContain("scripts/seed-db.sh");
    expect(messages).toContain('npm script "lint"');
    expect(messages).toContain('npm script "typecheck"');
    expect(messages).toContain("dashboard/components/");
    for (const finding of findings) expect(finding.severity).toBe("error");
    // Precision: prose like `try/catch` and negated-existence paths must not fire.
    expect(messages).not.toContain("try/catch");
    expect(messages).not.toContain("src/queue");
    expect(messages).not.toContain("feat/");
  });

  it("budget: oversized CLAUDE.md warns, and buried critical rules aggregate into one finding", async () => {
    const result = await messy();
    const findings = ofCategory(result, "budget");
    const oversize = findings.find((f) => f.message.includes("estimated tokens (budget: 1500)"));
    expect(oversize?.severity).toBe("warn");
    const buried = findings.filter((f) => f.message.includes("buried past 70% depth"));
    expect(buried).toHaveLength(1);
    const buriedTexts = (buried[0]?.ruleIds ?? []).map(
      (id) => result.rules.find((r) => r.id === id)?.text ?? "",
    );
    expect(buriedTexts.some((t) => t.includes("NEVER run `npm run migrate`"))).toBe(true);
    expect(buried[0]?.fix?.kind).toBe("move-to-front");
  });

  it("structure: sprawl consolidation suggestion + broken frontmatter", async () => {
    const findings = ofCategory(await messy(), "structure");
    expect(
      findings.some((f) => f.message.includes("Consolidate shared rules into AGENTS.md")),
    ).toBe(true);
    expect(findings.some((f) => f.message.includes("broken frontmatter"))).toBe(true);
  });

  it("load-semantics: legacy .cursorrules is flagged as read by nothing", async () => {
    const findings = ofCategory(await messy(), "load-semantics");
    expect(findings.some((f) => f.message.includes(".cursorrules"))).toBe(true);
  });
});

describe("M2 acceptance: scores", () => {
  it("clean-repo scores 100 with zero findings", async () => {
    const result = await runScan({ root: path.join(fixtures, "clean-repo"), userGlobalDir: null });
    expect(result.findings).toEqual([]);
    expect(result.score.total).toBe(100);
    expect(result.score.total).toBeGreaterThan(85);
  });

  it("scoring is deterministic: same input, same score", async () => {
    const a = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
    const b = await runScan({ root: path.join(fixtures, "messy-repo"), userGlobalDir: null });
    expect(a.score).toEqual(b.score);
    expect(scoreFindings(a.findings)).toEqual(scoreFindings(a.findings));
  });

  it("weights and penalties follow the documented formula", () => {
    const finding = (category: Finding["category"], severity: Finding["severity"]): Finding => ({
      ruleIds: [],
      surfaceIds: [],
      severity,
      category,
      message: "",
      evidence: "",
    });
    expect(scoreFindings([]).total).toBe(100);
    // One stale-reference error: freshness 75 -> total 100 - 0.25*25 = 93.75 -> 94
    expect(scoreFindings([finding("stale-reference", "error")]).total).toBe(94);
    // Errors floor a subscore at 0, never below.
    const five = Array.from({ length: 5 }, () => finding("duplication", "error"));
    expect(scoreFindings(five).subscores.uniqueness).toBe(0);
    expect(scoreFindings([...five, finding("duplication", "error")]).subscores.uniqueness).toBe(0);
  });
});

describe("similarity primitives", () => {
  it("identical short rules produce Jaccard 1 via whole-text shingle", () => {
    const a = shingles(normalizeWords("Use 2-space indentation."));
    const b = shingles(normalizeWords("Use 2-space indentation."));
    expect(jaccard(a, b)).toBe(1);
  });

  it("one changed word in a long rule lands in the drift band", () => {
    const base =
      "Before pushing, run npm test and make sure every test passes. Open a pull request against the main branch and request review from at least one backend engineer.";
    const changed = base.replace("main", "develop");
    const j = jaccard(shingles(normalizeWords(base)), shingles(normalizeWords(changed)));
    expect(j).toBeGreaterThanOrEqual(0.6);
    expect(j).toBeLessThan(0.9);
  });

  it("diffWords marks the changed hunk with context", () => {
    const diff = diffWords(
      normalizeWords("push to the main branch"),
      normalizeWords("push to the develop branch"),
    );
    expect(diff).toContain("[-main-]");
    expect(diff).toContain("{+develop+}");
  });
});

describe("glob mini-matcher", () => {
  it("handles **, *, and basename patterns", () => {
    expect(globToRegExp("src/**/*.js").test("src/a/b/c.js")).toBe(true);
    expect(globToRegExp("src/**/*.js").test("lib/a.js")).toBe(false);
    expect(globToRegExp("packages/web/**").test("packages/web/src/app.tsx")).toBe(true);
    expect(globMatchesAny("*.test.ts", ["src/lib/db.test.ts"])).toBe(true);
    expect(globMatchesAny("*.test.ts", ["src/lib/db.ts"])).toBe(false);
  });
});
