import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { runCompliance } from "../src/commands/compliance.js";
import { cacheKey, ruleHash, VerdictCache } from "../src/compliance/cache.js";
import { agreementReport, pickCalibrationSample } from "../src/compliance/calibrate.js";
import {
  buildJudgePrompt,
  estimateCost,
  type JudgeClient,
  type JudgePair,
  judgePairs,
  parseVerdict,
} from "../src/compliance/judge.js";
import { prepareChunk, prepareRule, ruleApplies } from "../src/compliance/prefilter.js";
import { chunkFileDiffs, sampleCommits, splitDiffByFile } from "../src/compliance/sampler.js";
import { DEFAULT_CONFIG, MODELS, pricingFor } from "../src/config.js";
import type { Rule } from "../src/core/model.js";
import { estimateTokens } from "../src/core/tokens.js";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-compliance-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t.com");
  await git(dir, "config", "user.name", "t");
  return dir;
}

async function commitFile(dir: string, file: string, content: string, message: string) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", message);
}

function fakeRule(text: string, referencedPaths: string[] = []): Rule {
  return {
    id: `fake:${text.slice(0, 10)}`,
    surfaceId: "fake",
    text,
    section: [],
    span: { startLine: 1, endLine: 1 },
    kind: "imperative",
    referencedPaths,
  };
}

function fakeChunk(diff: string, files: string[]) {
  return { id: `c${files.join()}`, sha: "abc123def456", files, diff, tokensEstimated: 10 };
}

/** JudgeClient returning canned responses, counting calls. */
function fakeClient(responder: (prompt: string) => string): JudgeClient & { calls: number } {
  const client = {
    calls: 0,
    async complete({ prompt }: { prompt: string }) {
      client.calls += 1;
      return responder(prompt);
    },
  };
  return client;
}

const FOLLOWED = '{"verdict":"followed","evidence":"looks compliant"}';
const VIOLATED = '{"verdict":"violated","evidence":"console.log left in"}';

describe("sampler", () => {
  it("falls back to plain commits when the history has no merges, skipping lockfiles", async () => {
    const dir = await makeRepo();
    await commitFile(dir, "src/a.js", "const a = 1;\n", "add a");
    await commitFile(dir, "package-lock.json", '{"lockfileVersion": 3}\n', "lockfile");
    await commitFile(dir, "src/b.js", "const b = 2;\n", "add b");

    const sample = await sampleCommits(dir, 10);
    expect("error" in sample).toBe(false);
    if ("error" in sample) return;
    expect(sample.usedMerges).toBe(false);
    expect(sample.commitsSampled).toBe(3);
    const files = sample.chunks.flatMap((c) => c.files);
    expect(files).toContain("src/a.js");
    expect(files).not.toContain("package-lock.json");
  }, 30000);

  it("degrades gracefully outside a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-nogit-"));
    const sample = await sampleCommits(dir, 10);
    expect(sample).toHaveProperty("error");
  });

  it("splits unified diffs per file and packs chunks under the token cap", () => {
    const segment = (file: string, lines: number) =>
      `diff --git a/${file} b/${file}\n${`+changed line in ${file}\n`.repeat(lines)}`;
    const segments = splitDiffByFile(segment("src/x.js", 60) + segment("src/y.js", 60));
    expect(segments.map((s) => s.file)).toEqual(["src/x.js", "src/y.js"]);

    // Two ~400-token segments cannot share a 500-token chunk.
    const chunks = chunkFileDiffs("sha1", segments, 500);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.tokensEstimated).toBeLessThanOrEqual(500);
    }
  });

  it("truncates a single oversized file diff to fit the cap, with a marker", () => {
    const huge = `diff --git a/src/big.js b/src/big.js\n${"+another changed line here\n".repeat(500)}`;
    const chunks = chunkFileDiffs("sha1", splitDiffByFile(huge), 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokensEstimated).toBeLessThanOrEqual(500);
    expect(chunks[0]?.diff).toContain("truncated by ctxlint");
  });
});

describe("prefilter", () => {
  it("matches on referenced paths, globs, and keyword overlap — and rejects unrelated pairs", () => {
    const byPath = prepareRule(
      fakeRule("Validate request bodies in src/routes/.", ["src/routes/"]),
    );
    const byGlob = prepareRule(fakeRule("Component rules apply.", ["src/**/*.tsx"]));
    const byKeywords = prepareRule(
      fakeRule("Never log request bodies because they contain customer addresses."),
    );
    const unrelated = prepareRule(fakeRule("Deploy dashboards through the platform pipeline."));

    const chunk = prepareChunk(
      fakeChunk(
        "diff --git a/src/routes/orders.js b/src/routes/orders.js\n+ log(request.bodies) // customer addresses",
        ["src/routes/orders.js"],
      ),
    );
    expect(ruleApplies(byPath, chunk)).toBe(true);
    expect(ruleApplies(byKeywords, chunk)).toBe(true);
    expect(ruleApplies(byGlob, chunk)).toBe(false);
    expect(ruleApplies(unrelated, chunk)).toBe(false);

    const tsxChunk = prepareChunk(fakeChunk("diff", ["src/components/App.tsx"]));
    expect(ruleApplies(byGlob, tsxChunk)).toBe(true);
  });
});

describe("judge verdict parsing", () => {
  it("accepts strict JSON, with or without surrounding prose", () => {
    expect(parseVerdict(FOLLOWED)).toEqual({ verdict: "followed", evidence: "looks compliant" });
    expect(parseVerdict(`Sure! Here is the verdict:\n${VIOLATED}\nHope that helps!`)?.verdict).toBe(
      "violated",
    );
  });

  it("rejects malformed output safely instead of throwing", () => {
    expect(parseVerdict("")).toBeUndefined();
    expect(parseVerdict("not json at all")).toBeUndefined();
    expect(parseVerdict('{"verdict": "maybe"}')).toBeUndefined();
    expect(parseVerdict('{"verdict": 42}')).toBeUndefined();
    expect(parseVerdict('{"nested": {"verdict": bad json')).toBeUndefined();
  });
});

describe("judging with cache", () => {
  it("serves repeat runs from the disk cache with zero client calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-cache-"));
    const cacheFile = path.join(dir, "cache.json");
    const pairs: JudgePair[] = [
      { rule: fakeRule("Never log bodies."), chunk: fakeChunk("+log(body)", ["a.js"]) },
      { rule: fakeRule("Validate input."), chunk: fakeChunk("+validate(x)", ["b.js"]) },
    ];

    const first = fakeClient(() => FOLLOWED);
    const cache1 = new VerdictCache(cacheFile);
    await cache1.load();
    const results1 = await judgePairs(pairs, first, MODELS.judge, cache1, 4);
    await cache1.save();
    expect(first.calls).toBe(2);
    expect(results1.every((r) => r.verdict === "followed" && !r.fromCache)).toBe(true);

    const second = fakeClient(() => {
      throw new Error("network must not be touched on a cache hit");
    });
    const cache2 = new VerdictCache(cacheFile);
    await cache2.load();
    const results2 = await judgePairs(pairs, second, MODELS.judge, cache2, 4);
    expect(second.calls).toBe(0);
    expect(results2.every((r) => r.verdict === "followed" && r.fromCache)).toBe(true);
  });

  it("records malformed model output as a per-pair error, not a crash, and does not cache it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-cache2-"));
    const cache = new VerdictCache(path.join(dir, "cache.json"));
    await cache.load();
    const client = fakeClient(() => "garbage");
    const pairs = [{ rule: fakeRule("Rule."), chunk: fakeChunk("+x", ["a.js"]) }];
    const results = await judgePairs(pairs, client, MODELS.judge, cache, 1);
    expect(results[0]?.error).toContain("unparseable");
    expect(
      cache.get(cacheKey(ruleHash("Rule."), pairs[0]?.chunk.id ?? "", MODELS.judge)),
    ).toBeUndefined();
  });
});

describe("cost estimator", () => {
  it("prices uncached pairs by prompt tokens at the model's rates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-cost-"));
    const cache = new VerdictCache(path.join(dir, "cache.json"));
    await cache.load();
    const pair: JudgePair = {
      rule: fakeRule("Never log bodies."),
      chunk: fakeChunk("+log(body)", ["a.js"]),
    };

    const cost = estimateCost([pair], cache, MODELS.judge);
    const promptTokens = estimateTokens(buildJudgePrompt(pair.rule.text, pair.chunk));
    const pricing = pricingFor(MODELS.judge);
    const expected =
      (promptTokens * pricing.inputPerMTok) / 1_000_000 + (200 * pricing.outputPerMTok) / 1_000_000;
    expect(cost.inputTokens).toBe(promptTokens);
    expect(cost.usd).toBeCloseTo(expected, 10);
    expect(cost.cachedPairs).toBe(0);

    // Once judged, the same pair costs nothing.
    await judgePairs(
      [pair],
      fakeClient(() => FOLLOWED),
      MODELS.judge,
      cache,
      1,
    );
    const cost2 = estimateCost([pair], cache, MODELS.judge);
    expect(cost2.cachedPairs).toBe(1);
    expect(cost2.usd).toBe(0);
  });
});

describe("calibration", () => {
  it("samples deterministically and reports agreement", () => {
    const judged = Array.from({ length: 10 }, (_, i) => ({
      rule: fakeRule(`Rule ${i}.`),
      chunk: fakeChunk(`+${i}`, [`f${i}.js`]),
      verdict: "followed" as const,
      evidence: "",
      fromCache: false,
    }));
    const sample = pickCalibrationSample(judged, 0.1);
    expect(sample).toHaveLength(1);
    expect(pickCalibrationSample(judged, 0.3).length).toBeGreaterThanOrEqual(3);

    const secondary = judged.slice(0, 4).map((p, i) => ({
      ...p,
      verdict: (i < 3 ? "followed" : "violated") as "followed" | "violated",
    }));
    const report = agreementReport(judged, secondary);
    expect(report.compared).toBe(4);
    expect(report.agreed).toBe(3);
    expect(report.agreement).toBeCloseTo(0.75);
  });
});

describe("runCompliance end to end (mocked client, no network)", () => {
  async function repoWithRulesAndHistory(): Promise<string> {
    const dir = await makeRepo();
    await commitFile(
      dir,
      "CLAUDE.md",
      [
        "# rules",
        "",
        "- Never use console.log in src/ code; use the logger from src/log.js.",
        "- All handlers in src/routes/ must validate the request body before use.",
        "- The quarterly finance export must use the cursed COBOL bridge in mainframe/.",
      ].join("\n"),
      "add rules",
    );
    await commitFile(dir, "src/log.js", "module.exports = { log: () => {} };\n", "logger");
    await commitFile(
      dir,
      "src/routes/orders.js",
      "console.log('hi'); // validate request body later\nmodule.exports = {};\n",
      "orders route",
    );
    return dir;
  }

  it("produces per-rule reports, flags dead rules, and honors the cache", async () => {
    const dir = await repoWithRulesAndHistory();
    const client = fakeClient((prompt) => (prompt.includes("console.log") ? VIOLATED : FOLLOWED));

    const outcome = await runCompliance(
      dir,
      { commits: 10, yes: true },
      { client, userGlobalDir: null },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.usedMerges).toBe(false);
    expect(outcome.reports.length).toBeGreaterThan(0);
    const violated = outcome.reports.find((r) => r.violated > 0);
    expect(violated?.evidences[0]?.evidence).toContain("console.log");
    // The COBOL rule matches nothing in this history -> dead-rule candidate.
    expect(outcome.deadRules.some((d) => d.rule.text.includes("COBOL"))).toBe(true);

    const offlineClient = fakeClient(() => {
      throw new Error("no network on rerun");
    });
    const rerun = await runCompliance(
      dir,
      { commits: 10, yes: true },
      { client: offlineClient, userGlobalDir: null },
    );
    expect(rerun.status).toBe("ok");
    expect(offlineClient.calls).toBe(0);
    expect(rerun.cost?.cachedPairs).toBe(rerun.cost?.pairs);
  }, 30000);

  it("refuses to spend above the cap without --yes", async () => {
    const dir = await repoWithRulesAndHistory();
    const config = structuredClone(DEFAULT_CONFIG);
    config.compliance.spendCapUsd = 0.0000001;
    const client = fakeClient(() => FOLLOWED);
    const outcome = await runCompliance(
      dir,
      { commits: 10 },
      { client, config, userGlobalDir: null },
    );
    expect(outcome.status).toBe("over-cap");
    expect(client.calls).toBe(0);
    expect(outcome.message).toContain("--yes");
  }, 30000);

  it("reports calibration agreement and marks low agreement as directional", async () => {
    const dir = await repoWithRulesAndHistory();
    const client = fakeClient(() => FOLLOWED);
    const disagreeing = fakeClient(() => VIOLATED);
    const outcome = await runCompliance(
      dir,
      { commits: 10, yes: true, calibrate: true },
      { client, calibrationClient: disagreeing, userGlobalDir: null },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.calibration).toBeDefined();
    expect(outcome.calibration?.agreement).toBe(0);
    expect(outcome.calibration?.threshold).toBe(0.8);
  }, 30000);

  it("degrades gracefully with a clear message when there is no git history", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-nohistory-"));
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      "# r\n\n- Never do the bad thing in src/.\n",
      "utf8",
    );
    const outcome = await runCompliance(
      dir,
      {},
      { client: fakeClient(() => FOLLOWED), userGlobalDir: null },
    );
    expect(outcome.status).toBe("no-git");
    expect(outcome.message).toContain("git history");
  });
});
