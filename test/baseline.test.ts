import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyBaseline,
  findingFingerprint,
  loadBaseline,
  writeBaseline,
} from "../src/core/baseline.js";
import type { Finding } from "../src/core/model.js";
import { runScan, type ScanResult } from "../src/core/pipeline.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function pathsOf(result: ScanResult): Map<string, string> {
  return new Map(result.surfaces.map((s) => [s.id, s.path]));
}

describe("finding fingerprints", () => {
  const base: Finding = {
    ruleIds: ["abc123:deadbeef0123"],
    surfaceIds: ["abc123"],
    severity: "error",
    category: "stale-reference",
    message: "CLAUDE.md:45-49 references `src/api/v1/` which does not exist",
    evidence: '"some rule text"',
  };

  it("survives line-number drift and token-count drift", () => {
    const paths = new Map([["abc123", "CLAUDE.md"]]);
    const moved: Finding = {
      ...base,
      message: "CLAUDE.md:52-56 references `src/api/v1/` which does not exist",
    };
    expect(findingFingerprint(base, paths)).toBe(findingFingerprint(moved, paths));
  });

  it("distinguishes different refs, categories, and files", () => {
    const paths = new Map([["abc123", "CLAUDE.md"]]);
    const otherRef: Finding = {
      ...base,
      message: "CLAUDE.md:45-49 references `docs/gone.md` which does not exist",
    };
    expect(findingFingerprint(base, paths)).not.toBe(findingFingerprint(otherRef, paths));
    const otherCategory: Finding = { ...base, category: "duplication" };
    expect(findingFingerprint(base, paths)).not.toBe(findingFingerprint(otherCategory, paths));
    const otherFile = new Map([["abc123", "AGENTS.md"]]);
    expect(findingFingerprint(base, paths)).not.toBe(findingFingerprint(base, otherFile));
  });
});

describe("baseline roundtrip", () => {
  it("suppresses every accepted finding on rescan and fails only on new ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-baseline-"));
    await cp(path.join(fixtures, "messy-repo"), dir, { recursive: true });

    const first = await runScan({ root: dir, userGlobalDir: null });
    expect(first.findings.length).toBeGreaterThan(0);
    await writeBaseline(
      dir,
      first.findings.map((f) => findingFingerprint(f, pathsOf(first))),
    );

    const baseline = await loadBaseline(dir);
    expect(baseline).toBeDefined();
    const second = await runScan({ root: dir, userGlobalDir: null });
    const applied = applyBaseline(second.findings, baseline as Set<string>, pathsOf(second));
    expect(applied.kept).toEqual([]);
    expect(applied.suppressed).toBe(second.findings.length);
    expect(applied.stale).toBe(0);

    // A NEW problem introduced after baselining is the only thing reported.
    await writeFile(
      path.join(dir, "AGENTS.md"),
      "# app\n\n- The deployment steps live in `docs/deploy-runbook.md`; follow them exactly.\n",
      "utf8",
    );
    const third = await runScan({ root: dir, userGlobalDir: null });
    const afterNew = applyBaseline(third.findings, baseline as Set<string>, pathsOf(third));
    expect(afterNew.kept.length).toBeGreaterThan(0);
    expect(
      afterNew.kept.some(
        (f) => f.category === "stale-reference" && f.message.includes("docs/deploy-runbook.md"),
      ),
    ).toBe(true);
  }, 30000);

  it("counts baseline entries that no longer match as stale", () => {
    const paths = new Map<string, string>();
    const applied = applyBaseline([], new Set(["gone1", "gone2"]), paths);
    expect(applied.stale).toBe(2);
    expect(applied.suppressed).toBe(0);
  });

  it("loadBaseline returns undefined when absent and throws on garbage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-nobase-"));
    expect(await loadBaseline(dir)).toBeUndefined();
    await writeFile(path.join(dir, ".ctxlint-baseline.json"), "not json", "utf8");
    await expect(loadBaseline(dir)).rejects.toThrow(/not valid JSON/);
  });
});

describe("inline ctxlint-ignore", () => {
  it("suppresses findings for marked rules — inline and standalone-line-above forms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-ignore-"));
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      [
        "# app",
        "",
        "- Legacy notes live in `docs/legacy-notes.md`; read them first. <!-- ctxlint-ignore -->",
        "",
        "<!-- ctxlint-ignore -->",
        "The old service description is in `docs/old-service.md` for the curious.",
        "",
        "- The real entrypoint is `src/missing-entry.ts`; start reading there.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await runScan({ root: dir, userGlobalDir: null });
    const stale = result.findings.filter((f) => f.category === "stale-reference");
    const messages = stale.map((f) => f.message).join("\n");
    expect(messages).not.toContain("docs/legacy-notes.md");
    expect(messages).not.toContain("docs/old-service.md");
    // The unmarked rule still fires — ignores are per-rule, not per-file.
    expect(messages).toContain("src/missing-entry.ts");
  });

  it("a marker on one list item does not leak to the next item", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-noleak-"));
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      [
        "# app",
        "",
        "- Ignored rule about `docs/gone-a.md` here. <!-- ctxlint-ignore -->",
        "- Live rule about `docs/gone-b.md` right below it.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await runScan({ root: dir, userGlobalDir: null });
    const messages = result.findings.map((f) => f.message).join("\n");
    expect(messages).not.toContain("docs/gone-a.md");
    expect(messages).toContain("docs/gone-b.md");
  });
});
