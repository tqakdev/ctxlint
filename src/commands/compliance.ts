import path from "node:path";
import pc from "picocolors";
import { VerdictCache } from "../compliance/cache.js";
import {
  agreementReport,
  pickCalibrationPairs,
  pickCalibrationSample,
} from "../compliance/calibrate.js";
import {
  anthropicJudgeClient,
  type CostEstimate,
  estimateCost,
  type JudgeClient,
  type JudgedPair,
  type JudgePair,
  judgePairs,
} from "../compliance/judge.js";
import { prepareChunk, prepareRule, ruleApplies } from "../compliance/prefilter.js";
import { sampleCommits } from "../compliance/sampler.js";
import { type CtxlintConfig, loadConfig } from "../config.js";
import type { Rule } from "../core/model.js";
import { runScan } from "../core/pipeline.js";
import { CACHE_DIR } from "./scan.js";

export interface ComplianceCliOptions {
  commits?: string;
  calibrate?: boolean;
  yes?: boolean;
}

export interface RuleReport {
  rule: Rule;
  surfacePath: string;
  applicable: number;
  followed: number;
  violated: number;
  errors: number;
  evidences: { verdict: string; evidence: string; sha: string }[];
}

export interface ComplianceOutcome {
  status: "ok" | "no-git" | "no-rules" | "over-cap" | "nothing-to-judge";
  message?: string;
  cost?: CostEstimate;
  reports: RuleReport[];
  deadRules: { rule: Rule; surfacePath: string }[];
  commitsSampled?: number;
  usedMerges?: boolean;
  judged?: JudgedPair[];
  calibration?: { compared: number; agreed: number; agreement: number; threshold: number };
}

export interface ComplianceDeps {
  client: JudgeClient;
  calibrationClient?: JudgeClient;
  config?: CtxlintConfig;
  userGlobalDir?: string | null;
}

/** Core compliance flow; deps are injectable so tests never touch the network. */
export async function runCompliance(
  root: string,
  options: { commits?: number; calibrate?: boolean; yes?: boolean },
  deps: ComplianceDeps,
): Promise<ComplianceOutcome> {
  const config = deps.config ?? (await loadConfig(root));
  const commits = options.commits ?? config.compliance.commits;

  const sample = await sampleCommits(root, commits);
  if ("error" in sample) {
    return {
      status: "no-git",
      message: `compliance needs git history: ${sample.error}. Nothing was judged.`,
      reports: [],
      deadRules: [],
    };
  }

  const scan = await runScan({ root, config, userGlobalDir: deps.userGlobalDir ?? null });
  const surfacesById = new Map(scan.surfaces.map((s) => [s.id, s]));
  const judgeable = scan.rules.filter((rule) => {
    const surface = surfacesById.get(rule.surfaceId);
    return rule.kind === "imperative" && surface && surface.scope !== "user-global";
  });
  if (judgeable.length === 0) {
    return {
      status: "no-rules",
      message: "no imperative rules found to judge — add instructions to your context files first.",
      reports: [],
      deadRules: [],
    };
  }

  const preparedChunks = sample.chunks.map(prepareChunk);
  const preparedRules = judgeable.map(prepareRule);
  const pairs: JudgePair[] = [];
  const applicableRuleIds = new Set<string>();
  for (const rule of preparedRules) {
    for (const chunk of preparedChunks) {
      if (ruleApplies(rule, chunk)) {
        pairs.push({ rule: rule.rule, chunk: chunk.chunk });
        applicableRuleIds.add(rule.rule.id);
      }
    }
  }

  const deadRules = judgeable
    .filter((rule) => !applicableRuleIds.has(rule.id))
    .map((rule) => ({
      rule,
      surfacePath: surfacesById.get(rule.surfaceId)?.path ?? rule.surfaceId,
    }));

  if (pairs.length === 0) {
    return {
      status: "nothing-to-judge",
      message: `none of the ${judgeable.length} rules matched any of the last ${sample.commitsSampled} change(s) — every rule is a dead-rule candidate for this sample.`,
      reports: [],
      deadRules,
      commitsSampled: sample.commitsSampled,
      usedMerges: sample.usedMerges,
    };
  }

  const cache = new VerdictCache(path.join(root, CACHE_DIR, "compliance-cache.json"));
  await cache.load();

  const cost = estimateCost(pairs, cache, config.compliance.model);
  // --calibrate re-judges a sample with a (pricier) second model; that spend
  // must count against the cap too. The actual sample is drawn from judged
  // pairs later, so estimate against the same every-k-th pick over all pairs.
  let calibrationCache: VerdictCache | undefined;
  let capUsd = cost.usd;
  if (options.calibrate) {
    calibrationCache = new VerdictCache(
      path.join(root, CACHE_DIR, "compliance-cache-calibration.json"),
    );
    await calibrationCache.load();
    const presample = pickCalibrationPairs(pairs, config.compliance.calibrationSampleRatio);
    capUsd += estimateCost(presample, calibrationCache, config.compliance.calibrationModel).usd;
  }
  if (capUsd > config.compliance.spendCapUsd && !options.yes) {
    return {
      status: "over-cap",
      message: `estimated spend $${capUsd.toFixed(4)}${options.calibrate ? " (including calibration)" : ""} exceeds the $${config.compliance.spendCapUsd.toFixed(2)} cap — re-run with --yes to proceed, or raise compliance.spendCapUsd.`,
      cost,
      reports: [],
      deadRules,
      commitsSampled: sample.commitsSampled,
      usedMerges: sample.usedMerges,
    };
  }

  const judged = await judgePairs(
    pairs,
    deps.client,
    config.compliance.model,
    cache,
    config.compliance.concurrency,
  );
  await cache.save();

  const reportsById = new Map<string, RuleReport>();
  for (const pair of judged) {
    let report = reportsById.get(pair.rule.id);
    if (!report) {
      report = {
        rule: pair.rule,
        surfacePath: surfacesById.get(pair.rule.surfaceId)?.path ?? pair.rule.surfaceId,
        applicable: 0,
        followed: 0,
        violated: 0,
        errors: 0,
        evidences: [],
      };
      reportsById.set(pair.rule.id, report);
    }
    if (pair.error !== undefined) {
      report.errors += 1;
      continue;
    }
    if (pair.verdict === "not-applicable") continue;
    report.applicable += 1;
    if (pair.verdict === "followed") report.followed += 1;
    if (pair.verdict === "violated") {
      report.violated += 1;
      report.evidences.push({
        verdict: "violated",
        evidence: pair.evidence,
        sha: pair.chunk.sha.slice(0, 10),
      });
    }
  }

  // Rules whose every judged pair came back not-applicable are dead-rule
  // candidates too — the prefilter thought they might apply; the judge said no.
  for (const report of reportsById.values()) {
    if (report.applicable === 0 && report.errors === 0) {
      deadRules.push({ rule: report.rule, surfacePath: report.surfacePath });
    }
  }

  const outcome: ComplianceOutcome = {
    status: "ok",
    cost,
    reports: [...reportsById.values()].sort(
      (a, b) => b.violated - a.violated || b.applicable - a.applicable,
    ),
    deadRules,
    commitsSampled: sample.commitsSampled,
    usedMerges: sample.usedMerges,
    judged,
  };

  if (options.calibrate && calibrationCache) {
    const calibrationSample = pickCalibrationSample(
      judged,
      config.compliance.calibrationSampleRatio,
    );
    const secondary = await judgePairs(
      calibrationSample,
      deps.calibrationClient ?? deps.client,
      config.compliance.calibrationModel,
      calibrationCache,
      config.compliance.concurrency,
    );
    await calibrationCache.save();
    const agreement = agreementReport(judged, secondary);
    outcome.calibration = { ...agreement, threshold: config.compliance.agreementWarnThreshold };
  }

  return outcome;
}

function renderOutcome(outcome: ComplianceOutcome): string {
  const lines: string[] = [];
  if (outcome.status !== "ok") {
    lines.push(`ctxlint compliance: ${outcome.message ?? outcome.status}`);
    if (outcome.deadRules.length > 0) {
      lines.push("");
      lines.push(`Dead-rule candidates (matched none of the sampled changes):`);
      for (const dead of outcome.deadRules.slice(0, 20)) {
        lines.push(
          `  - ${dead.surfacePath}:${dead.rule.span.startLine} "${dead.rule.text.slice(0, 80)}"`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push(
    pc.bold(
      `ctxlint compliance — judged ${outcome.judged?.length ?? 0} (rule, change) pair(s) across ${outcome.commitsSampled} ${outcome.usedMerges ? "merged change(s)" : "commit(s) (no merges in history)"}`,
    ),
  );
  if (outcome.cost) {
    lines.push(
      pc.dim(
        `  spend: ~$${outcome.cost.usd.toFixed(4)} estimated (${outcome.cost.cachedPairs}/${outcome.cost.pairs} served from cache)`,
      ),
    );
  }
  lines.push("");

  for (const report of outcome.reports) {
    if (report.applicable === 0 && report.errors === 0) continue;
    const followedPct =
      report.applicable === 0 ? 0 : Math.round((report.followed / report.applicable) * 100);
    const violatedPct =
      report.applicable === 0 ? 0 : Math.round((report.violated / report.applicable) * 100);
    const color = report.violated > 0 ? pc.red : pc.green;
    lines.push(
      `${color("●")} ${report.surfacePath}:${report.rule.span.startLine} — applicable ${report.applicable}, followed ${followedPct}%, violated ${violatedPct}%${report.errors > 0 ? pc.dim(` (${report.errors} judge error(s))`) : ""}`,
    );
    lines.push(pc.dim(`    "${report.rule.text.slice(0, 100)}"`));
    for (const evidence of report.evidences.slice(0, 3)) {
      lines.push(pc.yellow(`    violated @ ${evidence.sha}: "${evidence.evidence.slice(0, 120)}"`));
    }
  }

  if (outcome.deadRules.length > 0) {
    lines.push("");
    lines.push(
      pc.bold(
        `Dead-rule candidates (${outcome.deadRules.length}) — applied to nothing in this sample:`,
      ),
    );
    for (const dead of outcome.deadRules.slice(0, 20)) {
      lines.push(
        pc.dim(
          `  - ${dead.surfacePath}:${dead.rule.span.startLine} "${dead.rule.text.slice(0, 80)}"`,
        ),
      );
    }
    lines.push(
      pc.dim(
        "  A dead rule costs tokens on every request and never changes behavior — consider deleting.",
      ),
    );
  }

  if (outcome.calibration) {
    lines.push("");
    const pct = Math.round(outcome.calibration.agreement * 100);
    const headline = `CALIBRATION: ${pct}% agreement between judge and second model (${outcome.calibration.agreed}/${outcome.calibration.compared} verdicts)`;
    if (outcome.calibration.agreement < outcome.calibration.threshold) {
      lines.push(pc.bold(pc.red(`▲ ${headline}`)));
      lines.push(
        pc.bold(
          pc.red(
            `▲ Below ${Math.round(outcome.calibration.threshold * 100)}% — treat per-rule scores as DIRECTIONAL ONLY, not ground truth.`,
          ),
        ),
      );
    } else {
      lines.push(pc.bold(pc.green(`✓ ${headline}`)));
    }
  }

  lines.push("");
  lines.push(
    pc.dim("Verdicts are LLM judgments over sampled diffs — directional signal, not ground truth."),
  );
  lines.push("");
  return lines.join("\n");
}

export async function complianceCommand(
  targetPath: string | undefined,
  options: ComplianceCliOptions,
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "ctxlint: compliance needs ANTHROPIC_API_KEY set (it judges diffs with an Anthropic model).\n",
    );
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(targetPath ?? ".");
  const commits = options.commits ? Number(options.commits) : undefined;
  if (commits !== undefined && (!Number.isInteger(commits) || commits <= 0)) {
    process.stderr.write("ctxlint: --commits must be a positive integer\n");
    process.exitCode = 2;
    return;
  }

  const outcome = await runCompliance(
    root,
    { commits, calibrate: options.calibrate, yes: options.yes },
    { client: anthropicJudgeClient(), calibrationClient: anthropicJudgeClient() },
  );

  process.stdout.write(renderOutcome(outcome));
  if (outcome.status === "over-cap") process.exitCode = 1;
}
