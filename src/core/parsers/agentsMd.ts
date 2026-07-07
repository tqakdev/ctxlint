import type { Finding, Rule, Surface } from "../model.js";
import { extractRules } from "./markdown.js";

/** AGENTS.md and CLAUDE.md are plain markdown instruction files. */
export function parseAgentsMd(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  return { rules: extractRules(surface), findings: [] };
}
