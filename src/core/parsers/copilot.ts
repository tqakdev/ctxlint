import type { Finding, Rule, Surface } from "../model.js";
import { extractRules } from "./markdown.js";

/** .github/copilot-instructions.md is plain markdown. */
export function parseCopilot(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  return { rules: extractRules(surface), findings: [] };
}
