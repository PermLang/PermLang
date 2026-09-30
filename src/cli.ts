#!/usr/bin/env node
/**
 * The permlang command: check, lock, diff. It reads sources, config, and lock
 * files, writes the lock file, and runs `git show` to read a committed lock.
 * @module
 * @perm fs.read, fs.write, exec
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AdapterError } from "./adapters.js";
import { STRICTNESS_LEVELS, checkFiles, checkTsConfig, type CheckOptions, type Report, type Strictness } from "./check.js";
import { formatDiffMarkdown, formatDiffText, type ViaPaths } from "./diff.js";
import { LockError, buildLock, diffLocks, keyed, parseLock, serializeLock, type LockFile } from "./lock.js";
import { formatText, toJson } from "./report.js";

const USAGE = `Usage:
  permlang check [paths...] [options]    check permissions (and the lock file, if there is one)
  permlang lock  [paths...] [options]    write permlang.lock.json from the current code
  permlang diff  [base-ref] [options]    permission changes since base-ref (default HEAD)

Which files: paths, or --project <tsconfig.json>. With neither, ./tsconfig.json
if present, else ./src.

Options:
  --project, -p <tsconfig.json>   check the files of a TypeScript project
  --config <file>                 config file (default: ./permlang.config.json if present)
  --adapter <file.json>           add an adapter manifest (repeatable)
  --strictness <level>            sketch | development | production (default: development)
  --lock <file>                   lock file (default: ./permlang.lock.json)
  --no-lock                       check: don't compare against the lock file
  --json                          check: print the JSON report
  --head <ref>                    diff: compare against this commit instead of the working tree
  --format <text|markdown|json>   diff: output format (default: text)

permlang.config.json:
  { "strictness": "sketch", "adapters": ["./permlang/adapters/acme-sms.json"] }

Exit codes: 0 no errors, 1 permission errors, 2 usage or configuration error.`;

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;
const DEFAULT_CONFIG = "permlang.config.json";
const DEFAULT_LOCK = "permlang.lock.json";

class UsageError extends Error {}

interface Args {
  paths: string[];
  adapters: string[];
  project?: string;
  config?: string;
  strictness?: string;
  lock?: string;
  noLock: boolean;
  json: boolean;
  head?: string;
  format: string;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    const args = parseArgs(rest);
    if (command === "check") return check(args);
    if (command === "lock") return lock(args);
    if (command === "diff") return diff(args);
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  } catch (e) {
    if (e instanceof UsageError || e instanceof AdapterError || e instanceof LockError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

function parseArgs(rest: string[]): Args {
  const args: Args = { paths: [], adapters: [], noLock: false, json: false, format: "text" };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value.`);
      return v;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--no-lock") args.noLock = true;
    else if (arg === "--project" || arg === "-p") args.project = value();
    else if (arg === "--config") args.config = value();
    else if (arg === "--adapter") args.adapters.push(value());
    else if (arg === "--strictness") args.strictness = value();
    else if (arg === "--lock") args.lock = value();
    else if (arg === "--head") args.head = value();
    else if (arg === "--format") args.format = value();
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".\n\n${USAGE}`);
    else args.paths.push(arg);
  }
  return args;
}

// --- commands ----------------------------------------------------------------

function check(args: Args): number {
  const lockFile = args.lock ?? DEFAULT_LOCK;
  const useLock = !args.noLock && existsSync(lockFile);
  const lock = useLock ? { file: path.resolve(lockFile), contents: parseLock(readFileSync(lockFile, "utf8"), lockFile) } : undefined;
  const report = analyze(args, lock);
  console.log(args.json ? toJson(report) : formatText(report));
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

function lock(args: Args): number {
  const lockFile = path.resolve(args.lock ?? DEFAULT_LOCK);
  const previous = existsSync(lockFile) ? parseLock(readFileSync(lockFile, "utf8"), lockFile) : undefined;
  const report = analyze(args, undefined);
  const next = buildLock(report, path.dirname(lockFile));
  writeFileSync(lockFile, serializeLock(next));
  const changes = formatDiffText(diffLocks(previous, next), viaPaths(report, path.dirname(lockFile)));
  console.log(`Wrote ${path.relative(process.cwd(), lockFile) || lockFile} (${Object.keys(next.functions).length} functions).\n\n${changes}`);
  return 0;
}

function diff(args: Args): number {
  if (!["text", "markdown", "json"].includes(args.format)) throw new UsageError(`--format must be text, markdown, or json.`);
  if (args.paths.length > 1) throw new UsageError("diff takes one base ref.");
  const base = args.paths[0] ?? "HEAD";
  const lockFile = args.lock ?? DEFAULT_LOCK;

  const baseLock = lockAt(base, lockFile);
  let headLock: LockFile;
  let via: ViaPaths = {};
  if (args.head) {
    const found = lockAt(args.head, lockFile);
    if (!found) throw new UsageError(`${lockFile} doesn't exist at ${args.head}.`);
    headLock = found;
  } else {
    if (!existsSync(lockFile)) throw new UsageError(`No ${lockFile}. Run \`permlang lock\` first.`);
    headLock = parseLock(readFileSync(lockFile, "utf8"), lockFile);
    // The working tree can be analyzed, so new access can be shown with its path.
    via = viaPaths(analyze({ ...args, paths: [] }, undefined), path.dirname(path.resolve(lockFile)));
  }

  const changes = diffLocks(baseLock, headLock);
  if (args.format === "json") console.log(JSON.stringify({ base, head: args.head ?? "working tree", ...changes, via }, null, 2));
  else console.log(args.format === "markdown" ? formatDiffMarkdown(changes, via) : formatDiffText(changes, via));
  return 0;
}

// --- helpers -----------------------------------------------------------------

function analyze(args: Args, lock: CheckOptions["lock"]): Report {
  const config = readConfig(args.config);
  const strictness = args.strictness ?? config.strictness;
  if (strictness !== undefined && !STRICTNESS_LEVELS.includes(strictness as Strictness)) {
    throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  const options: CheckOptions = {
    adapters: [...args.adapters, ...config.adapters],
    ...(strictness ? { strictness: strictness as Strictness } : {}),
    ...(lock ? { lock } : {}),
  };

  if (args.project !== undefined) return checkTsConfig(args.project, options);
  if (args.paths.length === 0 && existsSync("tsconfig.json")) return checkTsConfig("tsconfig.json", options);
  const targets = args.paths.length > 0 ? args.paths : ["src"];
  const missing = targets.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new UsageError(`Not found: ${missing.join(", ")}`);
  return checkFiles(targets.flatMap(expand), options);
}

/** The lock file as committed at `ref`, or undefined if it didn't exist there. */
function lockAt(ref: string, lockFile: string): LockFile | undefined {
  const spec = `${ref}:./${lockFile.replaceAll("\\", "/")}`;
  let text: string;
  try {
    text = execFileSync("git", ["show", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(stderr)) return undefined;
    throw new UsageError(`Can't read ${lockFile} at ${ref}: ${stderr.trim() || (e as Error).message}`);
  }
  return parseLock(text, spec);
}

function viaPaths(report: Report, root: string): ViaPaths {
  return Object.fromEntries(keyed(report, root).map(({ key, fn }) => [key, fn.via]));
}

interface Config {
  strictness?: string;
  adapters: string[];
}

/** permlang.config.json, with adapter paths resolved relative to it. */
function readConfig(explicit: string | undefined): Config {
  const file = explicit ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (file === undefined) return { adapters: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`Can't read ${file}: ${(e as Error).message}`);
  }
  const config = raw as { adapters?: unknown; strictness?: unknown };
  const list = config.adapters ?? [];
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
    throw new UsageError(`${file}: "adapters" must be a list of manifest paths.`);
  }
  if (config.strictness !== undefined && typeof config.strictness !== "string") {
    throw new UsageError(`${file}: "strictness" must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  return {
    adapters: list.map((a) => path.resolve(path.dirname(file), a)),
    ...(config.strictness ? { strictness: config.strictness } : {}),
  };
}

/** A file, or every TypeScript source under a directory (declaration files included, for their types). */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}

process.exitCode = main(process.argv.slice(2));
