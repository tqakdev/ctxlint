import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import {
  applyBaseline,
  findingFingerprint,
  loadBaseline,
  writeBaseline,
} from "../core/baseline.js";
import { runScan } from "../core/pipeline.js";
import { scoreFindings } from "../core/scoring.js";
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
  /** Commander sets this false when --no-user-global is passed. */
  userGlobal?: boolean;
  /** Accept every current finding into .ctxlint-baseline.json. */
  writeBaseline?: boolean;
  /** Re-scan on file changes (long-running; ignores --ci). */
  watch?: boolean;
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

/** Paths whose changes must never re-trigger a watch scan (our own outputs). */
const WATCH_IGNORE = /(^|\/)(\.git|node_modules|\.ctxlint-cache)(\/|$)|(^|\/)ctxlint-fixes\.md$/;

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
  const exactCounter = await makeExactCounter();
  const outputFile = options.output ? path.resolve(options.output) : undefined;

  const runOnce = async (): Promise<ReportData | undefined> => {
    const result = await runScan({
      root,
      config,
      maxFiles,
      userGlobalDir: options.userGlobal === false ? null : path.join(os.homedir(), ".claude"),
      exactCounter,
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
      return undefined;
    }

    let baselineNote: { suppressed: number; stale: number } | undefined;
    const surfacePathById = new Map(result.surfaces.map((s) => [s.id, s.path]));
    if (options.writeBaseline) {
      const file = await writeBaseline(
        root,
        result.findings.map((f) => findingFingerprint(f, surfacePathById)),
      );
      process.stdout.write(
        `ctxlint: baseline written to ${file} — ${result.findings.length} finding(s) accepted. Commit it; future scans (and --ci) fail only on NEW findings.\n`,
      );
    } else {
      const baseline = await loadBaseline(root);
      if (baseline) {
        const { kept, suppressed, stale } = applyBaseline(
          result.findings,
          baseline,
          surfacePathById,
        );
        result.findings = kept;
        result.score = scoreFindings(kept);
        baselineNote = { suppressed, stale };
      }
    }

    const data = buildReportData(result);
    if (baselineNote) data.baseline = baselineNote;

    const cacheDir = path.join(root, CACHE_DIR);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, SCAN_CACHE_FILE), renderJson(data), "utf8");

    const output = renderReport(data, options.format ?? "text");
    if (outputFile) {
      await writeFile(outputFile, output, "utf8");
      process.stdout.write(`ctxlint: report written to ${options.output}\n`);
    } else {
      process.stdout.write(output);
    }
    return data;
  };

  const data = await runOnce();

  if (!options.watch) {
    if (options.ci && data && countBySeverity(data.findings).error > 0) {
      process.exitCode = 1;
    }
    return;
  }

  // Watch mode: any file change can flip findings (staleness checks the whole
  // repo index), so watch the tree, debounce, and re-run the same scan.
  const { watch } = await import("node:fs");
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;
  const rerun = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      if (process.stdout.isTTY) process.stdout.write("\x1Bc");
      await runOnce();
      process.stdout.write("ctxlint: watching for changes — Ctrl-C to stop\n");
    } catch (error) {
      process.stderr.write(`ctxlint: re-scan failed: ${(error as Error).message}\n`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void rerun();
      }
    }
  };
  watch(root, { recursive: true }, (_event, filename) => {
    if (filename) {
      const rel = filename.split(path.sep).join("/");
      if (WATCH_IGNORE.test(rel)) return;
      if (outputFile && path.join(root, rel) === outputFile) return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void rerun(), 400);
  });
  process.stdout.write("ctxlint: watching for changes — Ctrl-C to stop\n");
  await new Promise(() => {
    // Runs until Ctrl-C.
  });
}
