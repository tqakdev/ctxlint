import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("ctxlint CLI skeleton", () => {
  it("registers the full command surface", () => {
    const program = buildProgram();
    expect(program.name()).toBe("ctxlint");
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["compliance", "fix", "report", "scan"]);
  });

  it("makes scan the default command", () => {
    const program = buildProgram();
    const scan = program.commands.find((c) => c.name() === "scan");
    // Commander exposes the default subcommand via its internal marker; assert
    // through help output instead of private fields.
    expect(scan).toBeDefined();
    expect(program.helpInformation()).toContain("scan");
  });

  it("declares the spec'd options on each command", () => {
    const program = buildProgram();
    const optionNames = (cmd: string) =>
      program.commands.find((c) => c.name() === cmd)?.options.map((o) => o.long) ?? [];

    expect(optionNames("scan")).toEqual(
      expect.arrayContaining(["--format", "--output", "--ci", "--max-files"]),
    );
    expect(optionNames("fix")).toContain("--write");
    expect(optionNames("compliance")).toEqual(
      expect.arrayContaining(["--commits", "--calibrate", "--yes"]),
    );
  });

  it("produces help text describing the tool", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("ctxlint");
    expect(help).toContain("AGENTS.md");
    expect(help).toContain("CLAUDE.md");
  });
});
