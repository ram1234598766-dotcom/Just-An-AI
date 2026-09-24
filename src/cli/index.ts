#!/usr/bin/env node
import { Command } from "commander";
import { getPkgInfo } from "../version.js";
import { formatReport, runDoctor } from "../doctor.js";

const pkg = getPkgInfo();

const program = new Command();

program
  .name("jaa")
  .description(
    "J.A.A. — local-first, multi-provider terminal coding agent. " +
      "Bring your own key from any provider, or run fully local on Ollama.",
  )
  .version(pkg.version, "-v, --version", "print the jaa version")
  .showHelpAfterError();

program
  .command("doctor")
  .description("run environment diagnostics and print a report")
  .action(() => {
    console.log(formatReport(runDoctor()));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

const args = program.args;
if (args.length === 0 && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  // Interactive mode lands in Phase 5. Until then, bare `jaa` prints help.
  program.help();
}