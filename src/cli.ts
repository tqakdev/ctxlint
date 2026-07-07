#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ctxlint")
    .description(
      "Audit, profile, and score the context files steering AI coding agents\n" +
        "(AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc, copilot-instructions.md,\n" +
        ".windsurf/rules/*.md, skills).",
    )
    .version(pkg.version)
    .showHelpAfterError();

  program
    .command("scan [path]", { isDefault: true })
    .description("statically analyze context files: findings, health score, effective contexts")
    .option("--format <format>", "output format: text | json | md", "text")
    .option("--output <file>", "write the report to a file instead of stdout")
    .option("--ci", "exit with code 1 when error-severity findings exist")
    .option("--max-files <n>", "hard cap on files walked during discovery")
    .action(async (targetPath: string | undefined, options) => {
      const { scanCommand } = await import("./commands/scan.js");
      await scanCommand(targetPath, options);
    });

  program
    .command("fix [path]")
    .description("plan autofixes from scan findings; apply only safe patches with --write")
    .option("--write", "apply safe patches (refuses to run on a dirty git tree)")
    .action(async (targetPath: string | undefined, options) => {
      const { fixCommand } = await import("./commands/fix.js");
      await fixCommand(targetPath, options);
    });

  program
    .command("compliance [path]")
    .description("judge recent commits against your rules (requires ANTHROPIC_API_KEY)")
    .option("--commits <n>", "number of recent merged changes to sample")
    .option("--calibrate", "re-judge a sample with a second model and report agreement")
    .option("--yes", "proceed even when the estimated spend exceeds the cap")
    .action(async (targetPath: string | undefined, options) => {
      const { complianceCommand } = await import("./commands/compliance.js");
      await complianceCommand(targetPath, options);
    });

  program
    .command("report")
    .description("regenerate the last report from cached results without re-scanning")
    .option("--format <format>", "output format: text | json | md", "text")
    .option("--output <file>", "write the report to a file instead of stdout")
    .action(async (options) => {
      const { reportCommand } = await import("./commands/report.js");
      await reportCommand(options);
    });

  return program;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(`ctxlint: ${(error as Error).message}\n`);
      process.exit(2);
    });
}
