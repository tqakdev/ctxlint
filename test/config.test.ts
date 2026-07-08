import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, ConfigError, DEFAULT_CONFIG, loadConfig, MODELS } from "../src/config.js";

async function dirWithConfig(contents?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxlint-test-"));
  if (contents !== undefined) {
    await writeFile(path.join(dir, CONFIG_FILENAME), contents, "utf8");
  }
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig(await dirWithConfig());
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges overrides per section, keeping other defaults", async () => {
    const dir = await dirWithConfig(
      JSON.stringify({ budgets: { surfaceWarnTokens: 800 }, compliance: { commits: 10 } }),
    );
    const config = await loadConfig(dir);
    expect(config.budgets.surfaceWarnTokens).toBe(800);
    expect(config.budgets.effectiveContextWarnTokens).toBe(4000);
    expect(config.compliance.commits).toBe(10);
    expect(config.compliance.model).toBe(MODELS.judge);
  });

  it("rejects unknown sections and options by name", async () => {
    await expect(loadConfig(await dirWithConfig('{"budget": {}}'))).rejects.toThrow(
      /unknown section "budget"/,
    );
    await expect(
      loadConfig(await dirWithConfig('{"budgets": {"surfaceTokens": 1}}')),
    ).rejects.toThrow(/unknown option "budgets.surfaceTokens"/);
  });

  it("rejects values of the wrong type", async () => {
    await expect(
      loadConfig(await dirWithConfig('{"compliance": {"commits": "thirty"}}')),
    ).rejects.toThrow(ConfigError);
  });

  it("accepts discovery.exclude as an array of strings", async () => {
    const dir = await dirWithConfig('{"discovery": {"exclude": ["test/fixtures", "docs/**"]}}');
    const config = await loadConfig(dir);
    expect(config.discovery.exclude).toEqual(["test/fixtures", "docs/**"]);
    expect(config.discovery.maxFiles).toBe(DEFAULT_CONFIG.discovery.maxFiles);
  });

  it("rejects discovery.exclude that is not an array of strings", async () => {
    await expect(
      loadConfig(await dirWithConfig('{"discovery": {"exclude": "test/fixtures"}}')),
    ).rejects.toThrow(/"discovery.exclude" must be an array of strings/);
    await expect(
      loadConfig(await dirWithConfig('{"discovery": {"exclude": ["ok", 3]}}')),
    ).rejects.toThrow(/"discovery.exclude" must be an array of strings/);
  });

  it("rejects malformed JSON with the file named", async () => {
    await expect(loadConfig(await dirWithConfig("{nope"))).rejects.toThrow(/invalid JSON/);
  });

  it("keeps model names in one place", () => {
    expect(DEFAULT_CONFIG.compliance.model).toBe(MODELS.judge);
    expect(DEFAULT_CONFIG.compliance.calibrationModel).toBe(MODELS.calibration);
  });
});
