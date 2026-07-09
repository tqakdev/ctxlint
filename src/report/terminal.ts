import pc from "picocolors";
import type { Severity } from "../core/model.js";
import { countBySeverity, type ReportData } from "./data.js";

function scoreColor(score: number): (s: string) => string {
  if (score >= 85) return pc.green;
  if (score >= 60) return pc.yellow;
  return pc.red;
}

const SEVERITY_STYLE: Record<Severity, (s: string) => string> = {
  error: (s) => pc.red(s),
  warn: (s) => pc.yellow(s),
  info: (s) => pc.cyan(s),
};

const SEVERITY_MARK: Record<Severity, string> = { error: "✖", warn: "▲", info: "ℹ" };

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const render = (cells: string[]) =>
    `  ${cells.map((cell, i) => pad(cell, widths[i] as number)).join("  ")}`.trimEnd();
  return [pc.dim(render(headers)), ...rows.map(render)];
}

export function renderTerminal(data: ReportData): string {
  const lines: string[] = [];
  const counts = countBySeverity(data.findings);
  const color = scoreColor(data.score.total);

  lines.push("");
  lines.push(
    `${pc.bold("ctxlint")} — ${data.stats.surfaces} context file(s), ${data.stats.rules} rules`,
  );
  lines.push("");
  lines.push(`${pc.bold("Context Health Score:")} ${color(pc.bold(`${data.score.total}/100`))}`);
  const s = data.score.subscores;
  lines.push(
    pc.dim(
      `  freshness ${s.freshness}  uniqueness ${s.uniqueness}  consistency ${s.consistency}  budget ${s.budget}  structure ${s.structure}`,
    ),
  );
  lines.push("");

  if (data.surfaces.length > 0) {
    lines.push(pc.bold("Context files"));
    lines.push(
      ...table(
        ["file", "kind", "tools", "tokens≈", "rules"],
        data.surfaces.map((surface) => [
          surface.path,
          surface.kind,
          surface.tools.join(",") || "—",
          surface.tokensExact !== undefined
            ? `${surface.tokensExact} exact`
            : `≈${surface.tokensEstimated}`,
          String(surface.ruleCount),
        ]),
      ),
    );
    lines.push("");
  }

  for (const context of data.effectiveContexts) {
    if (context.entries.length === 0) continue;
    const conditional =
      context.conditionalTokensEstimated > 0
        ? pc.dim(` (+ ≈${context.conditionalTokensEstimated} conditional)`)
        : "";
    lines.push(
      `${pc.bold(context.tool)} @ ${context.directory} — ≈${context.totalTokensEstimated} tokens always-on${conditional}`,
    );
    lines.push(
      ...table(
        ["#", "file", "tokens≈", "why"],
        context.entries.map((entry) => [
          String(entry.order),
          entry.path,
          `≈${entry.tokensEstimated}`,
          entry.conditional ? pc.dim(entry.reason) : entry.reason,
        ]),
      ),
    );
    lines.push("");
  }

  lines.push(
    pc.bold(
      `Findings: ${counts.error > 0 ? pc.red(`${counts.error} error(s)`) : "0 errors"}, ${
        counts.warn > 0 ? pc.yellow(`${counts.warn} warning(s)`) : "0 warnings"
      }, ${counts.info} info`,
    ),
  );
  if (data.findings.length === 0) {
    lines.push(pc.green("  Nothing to report — this is a healthy setup."));
  }
  for (const finding of data.findings) {
    const style = SEVERITY_STYLE[finding.severity];
    lines.push(
      `  ${style(SEVERITY_MARK[finding.severity])} ${style(`[${finding.category}]`)} ${finding.message}`,
    );
    for (const evidenceLine of finding.evidence.split("\n")) {
      lines.push(pc.dim(`      ${evidenceLine}`));
    }
  }
  if (data.baseline && data.baseline.suppressed + data.baseline.stale > 0) {
    lines.push(
      pc.dim(
        `  ${data.baseline.suppressed} accepted finding(s) hidden by .ctxlint-baseline.json${
          data.baseline.stale > 0
            ? `; ${data.baseline.stale} baseline entr${data.baseline.stale === 1 ? "y" : "ies"} no longer match (fixed) — refresh with scan --write-baseline`
            : ""
        }`,
      ),
    );
  }
  lines.push("");
  lines.push(pc.dim(`Token counts: ${data.tokenNote}.`));
  if (data.toolBehavior.length > 0) {
    const oldest = data.toolBehavior.reduce((a, b) => (a.lastVerified <= b.lastVerified ? a : b));
    lines.push(
      pc.dim(
        `Load-order model verified against tool docs on ${oldest.lastVerified} — full provenance in --format md/json.`,
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}
