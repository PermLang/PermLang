#!/usr/bin/env node
// permlang check [paths...] [--project tsconfig.json] [--config permlang.config.json] [--adapter file.json] [--json]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AdapterError } from "./adapters.js";
import { checkFiles, checkTsConfig, type CheckOptions, type Report } from "./check.js";
import { formatText, toJson } from "./report.js";

const USAGE = `Usage:
  permlang check [paths...] [options]
  permlang diff <base> <head>        (coming in M5)

Checks that every function's @perm annotation covers what it touches.
With no paths or --project, uses ./tsconfig.json if present, else ./src.

Options:
  --project, -p <tsconfig.json>   check the files of a TypeScript project
  --config <file>                 config file (default: ./permlang.config.json if present)
  --adapter <file.json>           add an adapter manifest (repeatable)
  --json                          print the JSON report

permlang.config.json:
  { "adapters": ["./permlang/adapters/acme-sms.json"] }

Exit codes: 0 no errors, 1 permission errors, 2 usage or configuration error.`;

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;
const DEFAULT_CONFIG = "permlang.config.json";

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
  const adapters: string[] = [];
  let project: string | undefined;
  let config: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value.`);
      return v;
    };
    try {
      if (arg === "--json") json = true;
      else if (arg === "--project" || arg === "-p") project = value();
      else if (arg === "--config") config = value();
      else if (arg === "--adapter") adapters.push(value());
      else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".\n\n${USAGE}`);
      else paths.push(arg);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }

  let options: CheckOptions;
  try {
    options = { adapters: [...adapters, ...configAdapters(config)] };
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let report: Report;
  try {
    if (project !== undefined) {
      report = checkTsConfig(project, options);
    } else if (paths.length === 0 && existsSync("tsconfig.json")) {
      report = checkTsConfig("tsconfig.json", options);
    } else {
      const targets = paths.length > 0 ? paths : ["src"];
      const missing = targets.filter((p) => !existsSync(p));
      if (missing.length > 0) {
        console.error(`Not found: ${missing.join(", ")}`);
        return 2;
      }
      report = checkFiles(targets.flatMap(expand), options);
    }
  } catch (e) {
    if (e instanceof AdapterError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  console.log(json ? toJson(report) : formatText(report));
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

class UsageError extends Error {}

/** Adapter paths from the config file, resolved relative to it. */
function configAdapters(explicit: string | undefined): string[] {
  const file = explicit ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (file === undefined) return [];
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Can't read ${file}: ${(e as Error).message}`);
  }
  const list = (config as { adapters?: unknown }).adapters ?? [];
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
    throw new Error(`${file}: "adapters" must be a list of manifest paths.`);
  }
  return list.map((a) => path.resolve(path.dirname(file), a));
}

/** A file, or every TypeScript source under a directory (declaration files included, for their types). */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}

process.exitCode = main(process.argv.slice(2));
