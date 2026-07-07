import type { Finding, Rule, Surface } from "../model.js";
import { parseAgentsMd } from "./agentsMd.js";
import { parseCopilot } from "./copilot.js";
import { parseCursorRule } from "./cursorRule.js";
import { parseSkill } from "./skill.js";
import { parseWindsurfRule } from "./windsurfRule.js";

export interface ParseOutput {
  rules: Rule[];
  findings: Finding[];
}

export function parseSurface(surface: Surface): ParseOutput {
  switch (surface.kind) {
    case "cursor-rule":
      return parseCursorRule(surface);
    case "windsurf-rule":
      return parseWindsurfRule(surface);
    case "skill":
      return parseSkill(surface);
    case "copilot-instructions":
      return parseCopilot(surface);
    default:
      // agents-md, claude-md, and unknown plain-text/markdown surfaces.
      return parseAgentsMd(surface);
  }
}

export function parseAll(surfaces: Surface[]): ParseOutput {
  const rules: Rule[] = [];
  const findings: Finding[] = [];
  for (const surface of surfaces) {
    const output = parseSurface(surface);
    rules.push(...output.rules);
    findings.push(...output.findings);
  }
  return { rules, findings };
}
