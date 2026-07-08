import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runScan } from "../core/pipeline.js";
import { createExactCounter } from "../core/tokens.js";
import { buildReportData, countBySeverity, type ReportData } from "../report/data.js";
import { renderJson } from "../report/json.js";
import { renderMarkdown } from "../report/markdown.js";
import { renderSarif } from "../report/sarif.js";
import { renderTerminal } from "../report/terminal.js";

export interface ScanCliOptions {
  format?: string;
  output?: string;
  ci?: boolean;
  maxFiles?: string;
}

export const CACHE_DIR = ".ctxlint-cache";
export const SCAN_CACHE_FILE = "last-scan.json";

export function renderReport(data: ReportData, format: string): string {
  switch (format) {
    case "json":
      return renderJson(data);
    case "md":
      return renderMarkdown(data);
    case "sarif":
      return renderSarif(data);
    case "text":
      return renderTerminal(data);
    default:
      throw new Error(`unknown --format "${format}" (expected text | json | md | sarif)`);
  }
}

async function makeExactCounter() {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { MODELS } = await import("../config.js");
  return createExactCounter(new Anthropic(), MODELS.judge);
}

export async function scanCommand(
  targetPath: string | undefined,
  options: ScanCliOptions,
): Promise<void> {
  const root = path.resolve(targetPath ?? ".");
  const config = await loadConfig(root);
  const maxFiles = options.maxFiles ? Number(options.maxFiles) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles <= 0)) {
    process.stderr.write("ctxlint: --max-files must be a positive integer\n");
    process.exitCode = 2;
    return;
  }

  const result = await runScan({
    root,
    config,
    maxFiles,
    userGlobalDir: path.join(os.homedir(), ".claude"),
    exactCounter: await makeExactCounter(),
  });

  if (result.surfaces.length === 0) {
    process.stdout.write(
      [
        "No agent context files found — nothing steering your AI tools yet.",
        "",
        "Start with a single AGENTS.md at the repo root (Claude Code, Cursor,",
        "Copilot, and Codex all read it): describe your commands, architecture,",
        "and conventions, then re-run `ctxlint scan`.",
        "",
      ].join("\n"),
    );
    return;
  }

  const data = buildReportData(result);

  const cacheDir = path.join(root, CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, SCAN_CACHE_FILE), renderJson(data), "utf8");

  const output = renderReport(data, options.format ?? "text");
  if (options.output) {
    await writeFile(path.resolve(options.output), output, "utf8");
    process.stdout.write(`ctxlint: report written to ${options.output}\n`);
  } else {
    process.stdout.write(output);
  }

  if (options.ci && countBySeverity(data.findings).error > 0) {
    process.exitCode = 1;
  }
}
