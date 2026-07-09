/**
 * Seeded-defect recall for the benchmark corpus: precision says "what we flag
 * is real"; this measures the other side — "when a defect exists, do we flag
 * it?" — by synthesizing defects with known ground truth.
 *
 *   pnpm bench:recall     (requires bench/.cache checkouts: run `pnpm bench` first)
 *
 * Three seed classes, all evaluated against the PURE analyzers so every rerun
 * is milliseconds, not a filesystem mutation:
 *
 *   stale-reference — take a reference that resolves today, delete its target
 *     file(s) from the repo index, re-run the analyzer. Misses here are the
 *     price of precision heuristics (basename-anywhere, weak-ref gate).
 *   duplication (verbatim) — copy a rule into a second surface unchanged.
 *   drift (one-word) — copy a rule into a second surface with one interior
 *     word replaced; catchable only while shingle overlap stays >= 0.6.
 *
 * CAVEAT: seeds are drawn from references the extractor already found, so
 * this measures RESOLUTION and DETECTION recall, not extraction recall —
 * a mention the extractor never captured cannot be seeded this way.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDuplication } from "../src/core/analyzers/duplication.js";
import {
  analyzeStaleness,
  type RepoFacts,
  resolveRefTargets,
} from "../src/core/analyzers/staleness.js";
import type { Rule, Surface } from "../src/core/model.js";
import { runScan } from "../src/core/pipeline.js";
import type { CorpusEntry } from "./lib.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(benchDir, ".cache");

const STALE_SEEDS_PER_REPO = 12;
const DUP_SEEDS_PER_REPO = 6;

/** Deterministic spread: every k-th of the sorted candidates, up to n. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)] as T);
  return out;
}

function surfaceDir(surfacePath: string): string {
  const idx = surfacePath.lastIndexOf("/");
  return idx === -1 ? "." : surfacePath.slice(0, idx);
}

function factsWithout(facts: RepoFacts, removed: ReadonlySet<string>): RepoFacts {
  const files = facts.files.filter((f) => !removed.has(f));
  const dirSet = new Set<string>(["."]);
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return { ...facts, files, fileSet: new Set(files), dirSet };
}

interface Tally {
  caught: number;
  seeded: number;
}

function pct(t: Tally): string {
  return t.seeded === 0 ? "—" : `${((t.caught / t.seeded) * 100).toFixed(0)}%`;
}

async function measureRepo(entry: CorpusEntry) {
  const root = path.join(cacheDir, entry.name);
  const scan = await runScan({ root, userGlobalDir: null });
  const surfacesById = new Map(scan.surfaces.map((s) => [s.id, s]));
  const facts: RepoFacts = scan.index;

  // --- stale-reference seeds: refs that resolve to concrete files today.
  const staleCandidates: { rule: Rule; ref: string; targets: string[] }[] = [];
  for (const rule of scan.rules) {
    const surface = surfacesById.get(rule.surfaceId);
    if (!surface || surface.scope === "user-global") continue;
    for (const ref of rule.referencedPaths) {
      if (ref.startsWith("npm run ") || ref.includes("*") || ref.includes("?")) continue;
      const targets = resolveRefTargets(ref, surfaceDir(surface.path), rule.text, facts);
      if (targets.length > 0) staleCandidates.push({ rule, ref, targets });
    }
  }
  staleCandidates.sort((a, b) => `${a.rule.id}|${a.ref}`.localeCompare(`${b.rule.id}|${b.ref}`));

  const stale: Tally = { caught: 0, seeded: 0 };
  const staleMisses: string[] = [];
  for (const seed of spread(staleCandidates, STALE_SEEDS_PER_REPO)) {
    const mutated = factsWithout(facts, new Set(seed.targets));
    const findings = analyzeStaleness([seed.rule], surfacesById, mutated);
    const caught = findings.some(
      (f) => f.category === "stale-reference" && f.fix?.ref === seed.ref,
    );
    stale.seeded += 1;
    if (caught) stale.caught += 1;
    else staleMisses.push(`${seed.ref} (${surfacesById.get(seed.rule.surfaceId)?.path})`);
  }

  // --- duplication / drift seeds: plant a copy in a synthetic second surface.
  const phantom: Surface = {
    id: "recall-phantom",
    path: "PHANTOM.md",
    kind: "agents-md",
    scope: "repo-root",
    tools: ["claude-code"],
    raw: "",
    tokensEstimated: 0,
  };
  const dupSurfaces = new Map(surfacesById);
  dupSurfaces.set(phantom.id, phantom);
  const dupCandidates = scan.rules
    .filter((r) => r.kind === "imperative" && r.text.split(/\s+/).length >= 8)
    .sort((a, b) => a.id.localeCompare(b.id));

  const verbatim: Tally = { caught: 0, seeded: 0 };
  const oneWord: Tally = { caught: 0, seeded: 0 };
  for (const rule of spread(dupCandidates, DUP_SEEDS_PER_REPO)) {
    const copy: Rule = { ...rule, id: "recall-copy", surfaceId: phantom.id };
    const dupFindings = analyzeDuplication([rule, copy], dupSurfaces, 5000);
    verbatim.seeded += 1;
    if (dupFindings.some((f) => f.category === "duplication")) verbatim.caught += 1;

    const words = rule.text.split(/\s+/);
    const mutatedWords = [...words];
    mutatedWords[Math.floor(words.length / 2)] = "sideways";
    const drifted: Rule = { ...copy, text: mutatedWords.join(" ") };
    const driftFindings = analyzeDuplication([rule, drifted], dupSurfaces, 5000);
    oneWord.seeded += 1;
    if (driftFindings.length > 0) oneWord.caught += 1;
  }

  return { name: entry.name, stale, staleMisses, verbatim, oneWord };
}

async function main() {
  const corpus = JSON.parse(
    await readFile(path.join(benchDir, "corpus.json"), "utf8"),
  ) as CorpusEntry[];

  const totals = {
    stale: { caught: 0, seeded: 0 },
    verbatim: { caught: 0, seeded: 0 },
    oneWord: { caught: 0, seeded: 0 },
  };
  const rows: string[] = [];
  const allMisses: string[] = [];

  for (const entry of corpus) {
    let result: Awaited<ReturnType<typeof measureRepo>>;
    try {
      result = await measureRepo(entry);
    } catch (error) {
      console.error(
        `${entry.name}: skipped (${(error as Error).message}) — run \`pnpm bench\` to populate bench/.cache`,
      );
      continue;
    }
    totals.stale.caught += result.stale.caught;
    totals.stale.seeded += result.stale.seeded;
    totals.verbatim.caught += result.verbatim.caught;
    totals.verbatim.seeded += result.verbatim.seeded;
    totals.oneWord.caught += result.oneWord.caught;
    totals.oneWord.seeded += result.oneWord.seeded;
    rows.push(
      `  ${result.name.padEnd(14)} stale ${result.stale.caught}/${result.stale.seeded}  dup-verbatim ${result.verbatim.caught}/${result.verbatim.seeded}  drift-1word ${result.oneWord.caught}/${result.oneWord.seeded}`,
    );
    allMisses.push(...result.staleMisses.map((m) => `  ${result.name}: ${m}`));
  }

  console.log("\nSeeded-defect recall (resolution/detection recall — see file header caveat):\n");
  for (const row of rows) console.log(row);
  console.log(
    `\n  OVERALL  stale-reference ${pct(totals.stale)} (${totals.stale.caught}/${totals.stale.seeded})` +
      `  duplication-verbatim ${pct(totals.verbatim)} (${totals.verbatim.caught}/${totals.verbatim.seeded})` +
      `  drift-one-word ${pct(totals.oneWord)} (${totals.oneWord.caught}/${totals.oneWord.seeded})`,
  );
  if (allMisses.length > 0) {
    console.log("\nStale-reference misses (deliberate precision trade-offs to review):");
    for (const miss of allMisses) console.log(miss);
  }
}

await main();
