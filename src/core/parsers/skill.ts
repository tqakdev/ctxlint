import matter from "gray-matter";
import type { Finding, Rule, Surface } from "../model.js";
import { extractRules } from "./markdown.js";

/** SKILL.md: YAML frontmatter (name/description) + markdown body. */
export function parseSkill(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  const findings: Finding[] = [];
  let body = surface.raw;
  try {
    // Options object disables gray-matter's pre-parse cache (see cursorRule.ts).
    const parsed = matter(surface.raw, {});
    body = parsed.content;
    surface.meta = { ...surface.meta, ...(parsed.data as Record<string, unknown>) };
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "unparseable YAML";
    surface.meta = { ...surface.meta, frontmatterError: message };
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${message}) — the skill's name/description cannot be read. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  }

  const offset = surface.raw.split("\n").length - body.split("\n").length;
  const rules = extractRules({ ...surface, raw: body }).map((rule) => ({
    ...rule,
    span: {
      startLine: rule.span.startLine + offset,
      endLine: rule.span.endLine + offset,
    },
  }));
  return { rules, findings };
}
