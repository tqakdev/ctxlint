import { describe, expect, it } from "vitest";
import type { Surface } from "../src/core/model.js";
import { extractRules } from "../src/core/parsers/markdown.js";

function surface(raw: string): Surface {
  return {
    id: "surf01",
    path: "TEST.md",
    kind: "agents-md",
    scope: "repo-root",
    tools: [],
    raw,
    tokensEstimated: 0,
  };
}

describe("content-hash rule identity", () => {
  it("keeps a rule's id stable when other rules are inserted before it", () => {
    const before = extractRules(surface("# Rules\n\n- Never commit secrets.\n"));
    const after = extractRules(
      surface("# Rules\n\n- Run the linter first.\n- Never commit secrets.\n"),
    );
    const target = (rules: ReturnType<typeof extractRules>) =>
      rules.find((r) => r.text === "Never commit secrets.");
    expect(target(before)?.id).toBeDefined();
    expect(target(before)?.id).toBe(target(after)?.id);
  });

  it("keeps a rule's id stable across line-wrap reformatting", () => {
    const oneLine = extractRules(
      surface("- Always run the full test suite before pushing to main.\n"),
    );
    const wrapped = extractRules(
      surface("- Always run the full test suite\n  before pushing to main.\n"),
    );
    expect(oneLine[0]?.id).toBe(wrapped[0]?.id);
  });

  it("gives duplicate rule text in one surface distinct ids", () => {
    const rules = extractRules(surface("- Use pnpm, not npm.\n- Use pnpm, not npm.\n"));
    expect(rules).toHaveLength(2);
    expect(rules[0]?.id).not.toBe(rules[1]?.id);
    // Same content prefix so the duplication is visible in the id itself.
    expect(rules[1]?.id.startsWith(rules[0]?.id ?? "")).toBe(true);
  });

  it("scopes ids by surface so identical text in different files does not collide", () => {
    const a = extractRules(surface("- Prefer composition.\n"));
    const b = extractRules({ ...surface("- Prefer composition.\n"), id: "surf02" });
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });
});
