#!/usr/bin/env node
// permlang check [paths...] [--project tsconfig.json] [--json]

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { checkFiles, checkTsConfig, type Report } from "./check.js";
import { formatText, toJson } from "./report.js";

const USAGE = `Usage:
  permlang check [paths...] [--project <tsconfig.json>] [--json]
  permlang diff <base> <head>        (coming in M5)

Checks that every function's @perm annotation covers what it touches.
With no paths or --project, uses ./tsconfig.json if present, else ./src.

Exit codes: 0 no errors, 1 permission errors, 2 usage error.`;

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "diff") {
    console.error("permlang diff is not implemented yet (planned for M5).");
    return 2;
  }
  if (command !== "check") {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const paths: string[] = [];
  let project: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--project" || arg === "-p") project = rest[++i];
    else if (arg.startsWith("-")) {
      console.error(`Unknown option "${arg}".\n\n${USAGE}`);
      return 2;
    } else paths.push(arg);
  }
  if (rest.includes("--project") && project === undefined) {
    console.error("--project needs a path to a tsconfig.json.");
    return 2;
  }

  let report: Report;
  if (project !== undefined) {
    report = checkTsConfig(project);
  } else if (paths.length === 0 && existsSync("tsconfig.json")) {
    report = checkTsConfig("tsconfig.json");
  } else {
    const targets = paths.length > 0 ? paths : ["src"];
    const missing = targets.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      console.error(`Not found: ${missing.join(", ")}`);
      return 2;
    }
    report = checkFiles(targets.flatMap(expand));
  }

  console.log(json ? toJson(report) : formatText(report));
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/** A file, or every TypeScript source under a directory. */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.endsWith(".d.ts") && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}

process.exitCode = main(process.argv.slice(2));
