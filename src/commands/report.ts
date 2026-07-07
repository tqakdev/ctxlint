import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportData } from "../report/data.js";
import { CACHE_DIR, renderReport, SCAN_CACHE_FILE } from "./scan.js";

export interface ReportCliOptions {
  format?: string;
  output?: string;
}

/** Regenerate the last report from cached results without re-scanning. */
export async function reportCommand(options: ReportCliOptions): Promise<void> {
  const cachePath = path.join(path.resolve("."), CACHE_DIR, SCAN_CACHE_FILE);
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    process.stderr.write(
      `ctxlint: no cached scan found at ${cachePath} — run \`ctxlint scan\` first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let data: ReportData;
  try {
    data = JSON.parse(raw) as ReportData;
    if (data.version !== 1) throw new Error(`unsupported cache version ${data.version}`);
  } catch (error) {
    process.stderr.write(
      `ctxlint: cached scan is unreadable (${(error as Error).message}) — re-run \`ctxlint scan\`.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const output = renderReport(data, options.format ?? "text");
  if (options.output) {
    await writeFile(path.resolve(options.output), output, "utf8");
    process.stdout.write(`ctxlint: report written to ${options.output}\n`);
  } else {
    process.stdout.write(output);
  }
  process.stdout.write(`(from cached scan generated at ${data.generatedAt})\n`);
}
