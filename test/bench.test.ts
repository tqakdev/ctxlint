import { describe, expect, it } from "vitest";
import { computePrecision, findingKey, validateCorpus } from "../bench/lib.js";
import type { Finding } from "../src/core/model.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleIds: [],
    surfaceIds: [],
    severity: "error",
    category: "stale-reference",
    message: "AGENTS.md:12 references src/gone.ts which does not exist",
    evidence: "src/gone.ts",
    ...overrides,
  };
}

describe("benchmark corpus lib", () => {
  it("gives findings stable keys that differ by repo, category, and message", () => {
    const f = finding();
    expect(findingKey("codex", f)).toBe(findingKey("codex", f));
    expect(findingKey("codex", f)).not.toBe(findingKey("opencode", f));
    expect(findingKey("codex", f)).not.toBe(
      findingKey("codex", finding({ category: "duplication" })),
    );
    expect(findingKey("codex", f)).not.toBe(findingKey("codex", finding({ message: "other" })));
    // Key must not depend on volatile fields like evidence formatting.
    expect(findingKey("codex", f)).toBe(findingKey("codex", finding({ evidence: "reworded" })));
  });

  it("computes precision over labeled findings and counts the unlabeled", () => {
    const keys = ["a", "b", "c", "d"];
    const labels = { a: "tp", b: "tp", c: "fp" } as const;
    const result = computePrecision(keys, labels);
    expect(result.truePositives).toBe(2);
    expect(result.falsePositives).toBe(1);
    expect(result.unlabeled).toBe(1);
    expect(result.precision).toBeCloseTo(2 / 3);
  });

  it("reports null precision when nothing is labeled", () => {
    expect(computePrecision(["a"], {}).precision).toBeNull();
  });

  it("validates corpus entries: pinned sha, unique names, owner/repo slugs", () => {
    const good = { name: "codex", repo: "openai/codex", sha: "a".repeat(40), note: "AGENTS.md" };
    expect(validateCorpus([good])).toEqual([]);
    expect(validateCorpus([{ ...good, sha: "main" }])[0]).toMatch(/sha/);
    expect(validateCorpus([{ ...good, repo: "not a slug" }])[0]).toMatch(/repo/);
    expect(validateCorpus([good, good])[0]).toMatch(/duplicate/);
  });
});
