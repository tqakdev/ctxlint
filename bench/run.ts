/**
 * Benchmark corpus runner: scans pinned open-source repos and snapshots the
 * findings, so analyzer precision is measured on real-world structure instead
 * of hand-built fixtures.
 *
 *   pnpm bench            clone (cached), scan, write bench/snapshots/, report
 *   pnpm bench --check    fail when a fresh scan differs from the snapshots
 *
 * Label findings in bench/labels.json ({ "<key>": "tp" | "fp" }) to build the
 * published precision numbers; keys are printed next to each finding.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { compareFindings } from "../src/core/model.js";
import { runScan } from "../src/core/pipeline.js";
import {
  type BenchSnapshot,
  type CorpusEntry,
  computePrecision,
  type FindingLabel,
  findingKey,
  validateCorpus,
} from "./lib.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(benchDir, ".cache");
const snapshotsDir = path.join(benchDir, "snapshots");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Shallow-fetch the pinned sha into a cached checkout (idempotent). */
async function ensureCheckout(entry: CorpusEntry): Promise<string> {
  const dir = path.join(cacheDir, entry.name);
  const head = await execa("git", ["-C", dir, "rev-parse", "HEAD"], { reject: false });
  if (head.exitCode === 0 && head.stdout.trim() === entry.sha) return dir;
  await mkdir(dir, { recursive: true });
  if (head.exitCode !== 0) {
    await execa("git", ["init", "-q", dir]);
    await execa("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      `https://github.com/${entry.repo}.git`,
    ]);
  }
  await execa("git", ["-C", dir, "fetch", "-q", "--depth", "1", "origin", entry.sha]);
  await execa("git", ["-C", dir, "checkout", "-qf", entry.sha]);
  return dir;
}

async function snapshotOne(entry: CorpusEntry): Promise<BenchSnapshot> {
  const root = await ensureCheckout(entry);
  const result = await runScan({ root, userGlobalDir: null });
  return {
    name: entry.name,
    repo: entry.repo,
    sha: entry.sha,
    score: result.score.total,
    stats: { surfaces: result.surfaces.length, rules: result.rules.length },
    findings: [...result.findings].sort(compareFindings).map((finding) => ({
      key: findingKey(entry.name, finding),
      severity: finding.severity,
      category: finding.category,
      message: finding.message,
    })),
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const corpus = await readJson<CorpusEntry[]>(path.join(benchDir, "corpus.json"), []);
  const problems = validateCorpus(corpus);
  if (problems.length > 0 || corpus.length === 0) {
    for (const problem of problems) console.error(`corpus.json: ${problem}`);
    if (corpus.length === 0) console.error("corpus.json: no entries");
    process.exit(2);
  }
  const labels = await readJson<Record<string, FindingLabel>>(
    path.join(benchDir, "labels.json"),
    {},
  );
  await mkdir(snapshotsDir, { recursive: true });

  const allKeys: string[] = [];
  const keysByCategory = new Map<string, string[]>();
  let drifted = 0;
  for (const entry of corpus) {
    const snapshot = await snapshotOne(entry);
    const file = path.join(snapshotsDir, `${entry.name}.json`);
    const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (check) {
      const committed = await readJson<BenchSnapshot | null>(file, null);
      if (JSON.stringify(committed) !== JSON.stringify(snapshot)) {
        drifted += 1;
        console.error(`✖ ${entry.name}: scan output drifted from ${path.relative(".", file)}`);
      }
    } else {
      await writeFile(file, rendered, "utf8");
    }
    allKeys.push(...snapshot.findings.map((f) => f.key));
    for (const finding of snapshot.findings) {
      const bucket = keysByCategory.get(finding.category) ?? [];
      bucket.push(finding.key);
      keysByCategory.set(finding.category, bucket);
    }
    const p = computePrecision(
      snapshot.findings.map((f) => f.key),
      labels,
    );
    const precision = p.precision === null ? "unlabeled" : `${(p.precision * 100).toFixed(0)}%`;
    console.log(
      `${entry.name}@${entry.sha.slice(0, 7)}  score ${snapshot.score}/100  ` +
        `${snapshot.stats.surfaces} surfaces, ${snapshot.stats.rules} rules, ` +
        `${snapshot.findings.length} findings  precision ${precision}` +
        (p.unlabeled > 0 && p.precision !== null ? ` (${p.unlabeled} unlabeled)` : ""),
    );
    for (const finding of snapshot.findings) {
      const mark = labels[finding.key] ?? "??";
      console.log(`    [${mark}] ${finding.key}  [${finding.category}] ${finding.message}`);
    }
  }

  const overall = computePrecision(allKeys, labels);
  if (overall.precision !== null) {
    console.log(
      `\noverall precision: ${(overall.precision * 100).toFixed(1)}% ` +
        `(${overall.truePositives} tp / ${overall.falsePositives} fp, ${overall.unlabeled} unlabeled)`,
    );
    for (const [category, keys] of [...keysByCategory.entries()].sort()) {
      const p = computePrecision(keys, labels);
      const rate = p.precision === null ? "unlabeled" : `${(p.precision * 100).toFixed(0)}%`;
      console.log(`  ${category}: ${rate} (${p.truePositives} tp / ${p.falsePositives} fp)`);
    }
  } else {
    console.log(`\n${allKeys.length} findings, none labeled yet — fill bench/labels.json`);
  }
  if (check && drifted > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`bench: ${(error as Error).message}`);
  process.exit(2);
});
