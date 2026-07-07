import type { BudgetConfig } from "../../config.js";
import type { EffectiveContext, Finding, Rule, Surface } from "../model.js";

const CRITICAL = /\b(?:never|must(?: not)?|always|do not|don'?t)\b/i;

/**
 * Token-budget analysis: oversized surfaces, oversized effective contexts,
 * and critical rules buried deep in oversized files (likely lost in long
 * sessions — models attend most reliably to the front of injected context).
 */
export function analyzeBudget(
  surfaces: Surface[],
  rules: Rule[],
  contexts: EffectiveContext[],
  config: BudgetConfig,
): Finding[] {
  const findings: Finding[] = [];

  for (const surface of surfaces) {
    if (surface.tokensEstimated <= config.surfaceWarnTokens) continue;
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "budget",
      message: `${surface.path} is ≈${surface.tokensEstimated} estimated tokens (budget: ${config.surfaceWarnTokens}) — it is injected on every request for ${surface.tools.join(", ") || "no tool"}. Trim it or split rarely-needed sections into on-demand docs.`,
      evidence: `≈${surface.tokensEstimated} estimated tokens`,
      fix: {
        kind: "split-file",
        description:
          "Keep always-relevant rules here; move reference material (troubleshooting, history) into files agents read on demand.",
      },
    });

    // Aggregate buried critical rules into one finding per surface — nine
    // near-identical warnings would drown the report without saying more.
    const totalLines = surface.raw.split("\n").length;
    const buried = rules.filter(
      (rule) =>
        rule.surfaceId === surface.id &&
        rule.span.startLine / totalLines > config.buriedRuleDepthRatio &&
        rule.kind === "imperative" &&
        CRITICAL.test(rule.text),
    );
    if (buried.length > 0) {
      const deepest = buried[buried.length - 1] as Rule;
      const preview = buried
        .slice(0, 3)
        .map((r) => `${surface.path}:${r.span.startLine} "${r.text.slice(0, 90)}"`)
        .join("\n");
      findings.push({
        ruleIds: buried.map((r) => r.id),
        surfaceIds: [surface.id],
        severity: "warn",
        category: "budget",
        message: `${buried.length} critical rule(s) buried past ${Math.round(config.buriedRuleDepthRatio * 100)}% depth of an oversized file (${surface.path}, deepest at line ${deepest.span.startLine} = ${Math.round((deepest.span.startLine / totalLines) * 100)}%) — likely lost in long sessions. Move critical rules to the front.`,
        evidence: preview + (buried.length > 3 ? `\n… and ${buried.length - 3} more` : ""),
        fix: {
          kind: "move-to-front",
          description: "Move these rules into a section at the top of the file.",
        },
      });
    }
  }

  for (const context of contexts) {
    if (context.totalTokensEstimated <= config.effectiveContextWarnTokens) continue;
    const parts = context.surfaces
      .filter((e) => !e.conditional)
      .map((e) => `${e.surface.path} (≈${e.surface.tokensEstimated})`)
      .join(", ");
    findings.push({
      ruleIds: [],
      surfaceIds: context.surfaces.map((e) => e.surface.id),
      severity: "warn",
      category: "budget",
      message: `${context.tool} working in ${context.directory} loads ≈${context.totalTokensEstimated} estimated tokens of always-on context (budget: ${config.effectiveContextWarnTokens}) — that cost recurs on every request. Trim the files it loads: ${parts}.`,
      evidence: parts,
    });
  }

  return findings;
}
