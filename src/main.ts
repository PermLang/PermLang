/**
 * What the permlang command does: init, check, lock, diff, spec (cli.ts runs it). It
 * reads sources, config, and lock files, writes the lock file, and runs `git show` to
 * read a committed lock. In GitHub Actions it reads GITHUB_WORKSPACE, so annotations
 * name files from the repository root.
 * @module
 * @perm fs.read, fs.write, exec, env(GITHUB_WORKSPACE)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AdapterError, AdapterIndex, loadAdapters } from "./adapters.js";
import {
  STRICTNESS_LEVELS,
  UNMAPPED_POLICIES,
  checkFiles,
  checkTsConfig,
  type CheckOptions,
  type Diagnostic,
  type Report,
  type Strictness,
  type UnmappedPolicy,
} from "./check.js";
import { addedDependencies, type DependencyChange, type PackageJson } from "./deps.js";
import { commentMarker, formatDiffFailure, formatDiffMarkdown, formatDiffText, type DiffNotes, type ViaPaths } from "./diff.js";
import { LOCK_VERSION, LockError, buildLock, diffLocks, isConfigKey, keyed, lockDrift, parseLock, serializeLock, type LockFile } from "./lock.js";
import { formatAnnotations, formatText, printable, toJson, toSarif } from "./report.js";
import { DEFAULT_CONFIG, SettingsError, readConfig, readTsConfig, settingsEntries, type Origin, type Settings } from "./settings.js";
import { checkSpecs, formatSpecResults } from "./spec/check.js";
import { parseSpecs, type Spec, type SpecError } from "./spec/parse.js";

const USAGE = `Usage:
  permlang --version                     print the version
  permlang init  [paths...] [options]    set up: a sketch-level config and a first lock file
  permlang check [paths...] [options]    check permissions (and the lock file, if there is one)
  permlang lock  [paths...] [options]    write permlang.lock.json from the current code
  permlang diff  [base-ref] [paths...]   permission changes since base-ref (default HEAD)
  permlang spec  [paths...] [options]    check .perm specs against the code (phase 2 groundwork)

Which files: paths, or --project <tsconfig.json>. With neither, ./tsconfig.json
if present, else ./src.

Options:
  --project, -p <tsconfig.json>   check the files of a TypeScript project
  --config <file>                 config file (default: ./permlang.config.json if present)
  --adapter <file.json>           add an adapter manifest (repeatable)
  --strictness <level>            sketch | development | production (default: development)
  --unmapped <policy>             packages with no adapter: warn | error | trust (default: warn)
  --lock <file>                   lock file (default: ./permlang.lock.json)
  --no-lock                       check: don't compare against the lock file
  --require-lock                  check: fail when the lock file is missing (the Action passes
                                  it when the pull request's base commit has one)
  --json                          check: print the JSON report
  --github-annotations            check: also print a GitHub Actions annotation per diagnostic
                                  (on standard error with --json, so the JSON stays valid)
  --sarif <file>                  check: also write the findings as SARIF, for GitHub code scanning
  --head <ref>                    diff: compare against this commit instead of the working tree
  --format <text|markdown|json>   diff: output format (default: text)
  --workflow                      init: also add .github/workflows/permlang.yml
  --spec <file.perm>              spec: check this spec (repeatable; default: every .perm file here)

permlang.config.json:
  { "strictness": "sketch", "unmapped": "warn", "adapters": ["./permlang/adapters/acme-sms.json"] }
  Also "tools": "warn" | "error" | "trust", and "flows": [{ "from": "env(KEY)", "to": ["net(host)"] }].

The lock file records which files were checked, and the settings in effect (options
included): check with the same paths and options it was written with.

Exit codes: 0 no errors, 1 permission errors, 2 anything else (a usage or configuration
error, a file that can't be read or written, or an internal error).`;

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;
const DEFAULT_LOCK = "permlang.lock.json";
const ISSUES = "https://github.com/PermLang/PermLang/issues";

class UsageError extends Error {}

interface Args {
  paths: string[];
  adapters: string[];
  project?: string;
  config?: string;
  strictness?: string;
  unmapped?: string;
  lock?: string;
  noLock: boolean;
  requireLock: boolean;
  workflow: boolean;
  specs: string[];
  json: boolean;
  githubAnnotations: boolean;
  sarif?: string;
  head?: string;
  format: string;
}

/** This package's version. package.json sits one level above both src/ and dist/. */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** Runs the command with these arguments, and returns its exit code. */
export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(packageVersion());
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseArgs(rest);
    if (command === "init") return init(args);
    if (command === "check") return check(args);
    if (command === "lock") return lock(args);
    if (command === "diff") return diff(args);
    if (command === "spec") return spec(args);
    throw new UsageError(`Unknown command "${printable(command)}".\n\n${USAGE}`);
  } catch (e) {
    // Exit code 1 means permission errors and nothing else, so CI can tell a failed check from a broken one.
    console.error(expectedError(e) ?? internalError(e));
    return 2;
  }
}

/** The message for an error that isn't a bug in PermLang: bad arguments or settings, or a file it can't read or write. */
function expectedError(e: unknown): string | undefined {
  if (e instanceof UsageError || e instanceof AdapterError || e instanceof LockError || e instanceof SettingsError) return e.message;
  // A system error (ENOENT, EACCES, ...) reading or writing a file.
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof Error && typeof code === "string" && /^E[A-Z]+$/.test(code)) return printable(e.message);
  return undefined;
}

/** A bug: the error and where it happened, to report. */
function internalError(e: unknown): string {
  const error = e instanceof Error ? e : new Error(String(e));
  const stack = error.stack ?? "";
  const frames = stack.includes("\n    at ") ? stack.slice(stack.indexOf("\n    at ")) : "";
  return `PermLang hit an internal error. Please report it at ${ISSUES}, with this:\n${printable(`${error.name}: ${error.message}`)}${frames}`;
}

function parseArgs(rest: string[]): Args {
  const args: Args = { paths: [], adapters: [], specs: [], noLock: false, requireLock: false, workflow: false, json: false, githubAnnotations: false, format: "text" };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value.`);
      return v;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--github-annotations") args.githubAnnotations = true;
    else if (arg === "--sarif") args.sarif = value();
    else if (arg === "--no-lock") args.noLock = true;
    else if (arg === "--require-lock") args.requireLock = true;
    else if (arg === "--workflow") args.workflow = true;
    else if (arg === "--spec") args.specs.push(value());
    else if (arg === "--project" || arg === "-p") args.project = value();
    else if (arg === "--config") args.config = value();
    else if (arg === "--adapter") args.adapters.push(value());
    else if (arg === "--strictness") args.strictness = value();
    else if (arg === "--unmapped") args.unmapped = value();
    else if (arg === "--lock") args.lock = value();
    else if (arg === "--head") args.head = value();
    else if (arg === "--format") args.format = value();
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${printable(arg)}".\n\n${USAGE}`);
    else args.paths.push(arg);
  }
  return args;
}

// --- commands ----------------------------------------------------------------

/** Day-one setup: a sketch-level config (unless one exists), a first lock file, optionally the workflow. */
function init(args: Args): number {
  const done: string[] = [];
  const configFile = args.config ?? DEFAULT_CONFIG;
  if (existsSync(configFile)) {
    done.push(`Kept ${configFile}.`);
  } else {
    const strictness = args.strictness ?? "sketch";
    if (!STRICTNESS_LEVELS.includes(strictness as Strictness)) {
      throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
    }
    writeFileSync(configFile, `${JSON.stringify({ strictness }, null, 2)}\n`);
    const meaning = strictness === "sketch" ? ": rules are reported, not enforced; new access the lock file doesn't record still fails" : "";
    done.push(`Wrote ${configFile} (strictness ${strictness}${meaning}).`);
  }

  const lockFile = path.resolve(args.lock ?? DEFAULT_LOCK);
  // --strictness went into the config written above (or was ignored, for one kept): the lock records the config's.
  const report = analyze({ ...args, strictness: undefined });
  const lock = buildLock(report, path.dirname(lockFile));
  writeFileSync(lockFile, serializeLock(lock));
  const lockName = path.relative(process.cwd(), lockFile).replaceAll("\\", "/");
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const reaching = Object.keys(lock.functions).length;
  done.push(`Wrote ${lockName}: ${count(reaching, "function")} ${reaching === 1 ? "reaches" : "reach"} something, across ${count(report.files, "file")}.`);

  const workflow = ".github/workflows/permlang.yml";
  if (args.workflow) {
    if (existsSync(workflow)) {
      done.push(`Kept ${workflow}.`);
    } else {
      mkdirSync(path.dirname(workflow), { recursive: true });
      writeFileSync(workflow, workflowFile(args));
      done.push(`Wrote ${workflow}: checks every pull request and comments the permission diff.`);
    }
  }

  const commit = [configFile, lockName, ...(args.workflow ? [workflow] : [])].join(", ");
  const steps = [
    `Commit ${commit}.`,
    "From now on, `permlang check` fails when code reaches something the lock doesn't record. Run `permlang lock` to accept a change, and review the lock's diff.",
    ...(report.unmapped.length > 0 ? [`Review the ${report.unmapped.length} packages with no adapter; \`permlang check\` lists them.`] : []),
    'Add @perm annotations where you want rules enforced, then raise "strictness" to development.',
  ];
  console.log([...done, "", "Next steps:", ...steps.map((s) => `  - ${s}`)].join("\n"));
  return 0;
}

/** A workflow that runs the PermLang Action on the same files init checked. */
/**
 * How to install the project's dependencies in CI, from its lockfile. PermLang reads code through
 * the TypeScript compiler: without the dependencies' types (`@types/node` above all), file, process,
 * and environment access are invisible. Install scripts are skipped; they aren't needed for types.
 */
function installSteps(): string[] {
  if (existsSync("pnpm-lock.yaml")) return ["      - run: corepack enable", "      - run: pnpm install --frozen-lockfile --ignore-scripts"];
  if (existsSync("yarn.lock")) return ["      - run: corepack enable", "      - run: yarn install --ignore-scripts"];
  if (existsSync("package-lock.json")) return ["      - run: npm ci --ignore-scripts --no-audit --no-fund"];
  return ["      - run: npm install --ignore-scripts --no-audit --no-fund"];
}

function workflowFile(args: Args): string {
  const selection = args.project ? `--project ${args.project}` : args.paths.join(" ");
  const withArgs = selection ? `\n        with:\n          args: ${selection}` : "";
  return [
    "name: PermLang",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  permissions:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: actions/setup-node@v7",
    "        with:",
    "          node-version: lts/*",
    "      # PermLang needs your dependencies' types (@types/node above all) to see file, process,",
    "      # and environment access. If you generate code, such as `prisma generate`, add it here too.",
    ...installSteps(),
    `      - uses: PermLang/permlang@v0${withArgs}`,
    "",
  ].join("\n");
}

function check(args: Args): number {
  if (args.noLock && args.requireLock) throw new UsageError("--no-lock and --require-lock can't be used together.");
  const lockName = args.lock ?? DEFAULT_LOCK;
  const lockFile = path.resolve(lockName);
  let committed: { contents: LockFile; text: string } | undefined;
  if (!args.noLock) {
    if (existsSync(lockFile)) {
      const text = readText(lockName);
      committed = { contents: parseLock(text, lockName), text };
    } else if (args.lock !== undefined) {
      // A mistyped --lock would otherwise turn the comparison off.
      const shown = printable(args.lock);
      throw new UsageError(`${shown} doesn't exist. Run \`permlang lock --lock ${shown}\` to create it, or fix the path.`);
    }
  }
  const report = analyze(args);
  if (committed) report.diagnostics.push(...lockDrift(committed.contents, buildLock(report, path.dirname(lockFile)), report, lockFile, committed.text));
  else if (args.requireLock) report.diagnostics.push(missingLock(lockFile));
  report.diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  // Paths in annotations and SARIF are relative to the repository root in GitHub Actions.
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  // Written even with no findings, so code scanning closes alerts for fixed problems.
  if (args.sarif) writeText(args.sarif, `${toSarif(report, root, packageVersion())}\n`);
  console.log(args.json ? toJson(report) : formatText(report));
  // In GitHub Actions, each diagnostic then shows on its line in the pull request. The runner
  // reads standard error too, which keeps --json's output valid JSON.
  if (args.githubAnnotations && report.diagnostics.length > 0) (args.json ? console.error : console.log)(formatAnnotations(report, root));
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/** --require-lock with no lock file: the comparison that catches new access can't run. */
function missingLock(lockFile: string): Diagnostic {
  const name = path.basename(lockFile);
  return {
    severity: "error",
    code: "PERM005",
    file: lockFile,
    line: 1,
    column: 1,
    function: "<lock>",
    capability: "",
    call: "",
    message: `${name} is missing. Without it, new access can't be told from old.`,
    fix: `restore ${name}, or run \`permlang lock\` and commit it so reviewers see everything it records.`,
  };
}

/** Checks .perm specs' permissions against the code that implements them (phase 2 groundwork). */
function spec(args: Args): number {
  const files = args.specs.length > 0 ? args.specs : findSpecFiles(".");
  const vocabulary = new AdapterIndex(loadAdapters([...args.adapters, ...readConfig(args.config).adapters]).adapters).vocabulary;
  const specs: Spec[] = [];
  const errors: SpecError[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new UsageError(`Not found: ${file}`);
    const parsed = parseSpecs(readFileSync(file, "utf8"), path.resolve(file), vocabulary);
    specs.push(...parsed.specs);
    errors.push(...parsed.errors);
  }
  const results = checkSpecs(specs, analyze(args));

  if (args.json) {
    console.log(JSON.stringify({ errors, results: results.map(({ spec: s, ...r }) => ({ spec: s.name, file: s.file, ...r })) }, null, 2));
  } else {
    for (const e of errors) console.log(`${path.relative(process.cwd(), e.file).replaceAll("\\", "/")}:${e.line} error SPEC001: ${printable(e.message)}`);
    if (errors.length > 0) console.log("");
    console.log(formatSpecResults(results));
  }
  const failed = errors.length > 0 || results.some((r) => r.diagnostics.some((d) => d.severity === "error"));
  return failed ? 1 : 0;
}

function findSpecFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".perm") && !f.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith(".")))
    .map((f) => path.join(root, f));
}

function lock(args: Args): number {
  const lockName = args.lock ?? DEFAULT_LOCK;
  const lockFile = path.resolve(lockName);
  const notes: string[] = [];
  let previous: LockFile | undefined;
  if (existsSync(lockFile)) {
    try {
      previous = parseLock(readText(lockName), lockName);
    } catch (e) {
      // Every lock error says to run `permlang lock`, so it must be able to start over.
      if (!(e instanceof LockError || e instanceof UsageError)) throw e;
      notes.push(`Couldn't read the old ${path.basename(lockFile)} (${e.message}), so this writes a new one: review all of it.`);
    }
  }
  const report = analyze(args);
  const next = buildLock(report, path.dirname(lockFile));
  writeText(lockFile, serializeLock(next));
  if (previous && previous.permlang !== LOCK_VERSION) notes.push(`Updated ${path.basename(lockFile)} from lock format ${previous.permlang} to ${LOCK_VERSION}, which also records the check's settings.`);
  const changes = formatDiffText(diffLocks(previous, next), viaPaths(report, path.dirname(lockFile)));
  const keys = Object.keys(next.functions);
  const functions = keys.filter((k) => !isConfigKey(k)).length;
  const counts = `${functions} function${functions === 1 ? "" : "s"}, ${keys.length - functions} configuration entr${keys.length - functions === 1 ? "y" : "ies"}`;
  console.log([`Wrote ${path.relative(process.cwd(), lockFile) || lockFile} (${counts}).`, ...notes, changes].join("\n\n"));
  return 0;
}

function diff(args: Args): number {
  if (!["text", "markdown", "json"].includes(args.format)) throw new UsageError(`--format must be text, markdown, or json.`);
  // Each folder of a repository gets its own comment: the marker names the folder.
  const marker = commentMarker(path.relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.cwd()));
  try {
    return diffAt(args, marker);
  } catch (e) {
    // Still a comment, which the Action posts over the previous one rather than leave that looking current.
    if (args.format === "markdown") console.log(formatDiffFailure(expectedError(e) ?? `internal error: ${printable(e instanceof Error ? e.message : String(e))}`, marker));
    throw e;
  }
}

function diffAt(args: Args, marker: string): number {
  // diff [base-ref] [paths...]: the paths select the code analyzed for "reached through".
  const [base = "HEAD", ...sources] = args.paths;
  const lockName = args.lock ?? DEFAULT_LOCK;
  const root = path.dirname(path.resolve(lockName));

  const baseLock = lockAt(base, lockName);
  const notes: DiffNotes = {
    lockFile: path.basename(lockName),
    enforced: !args.noLock,
    baseMissing: baseLock === undefined,
    baseOutdated: baseLock?.permlang === 1,
    marker,
  };
  let headLock: LockFile;
  let via: ViaPaths = {};
  // For each capability, the AI tools that can trigger it (from analyzing the working tree).
  const aiTools: Record<string, string[]> = {};
  if (args.head) {
    const found = lockAt(args.head, lockName);
    if (!found) throw new UsageError(`${lockName} doesn't exist at ${printable(args.head)}.`);
    headLock = found;
  } else {
    const diskLock = existsSync(lockName) ? parseLock(readText(lockName), lockName) : undefined;
    if (!diskLock && !baseLock) throw new UsageError(`No ${lockName}. Run \`permlang lock\` first.`);
    // A pull request that deletes the lock turns the comparison off: the comment must say so.
    notes.lockDeleted = diskLock === undefined;
    notes.lockOutdated = diskLock?.permlang === 1;
    headLock = diskLock ?? { permlang: LOCK_VERSION, functions: {}, unsafe: {} };
    // The working tree is the truth: diff the base against what the code reaches now, not only
    // what the lock says, and note where the two differ (the check fails on that). If the code
    // can't be analyzed, the diff shows the lock files alone, and says so.
    try {
      const report = analyze({ ...args, paths: sources });
      via = viaPaths(report, root);
      for (const t of report.tools) for (const c of t.reaches) (aiTools[c] ??= []).push(t.name);
      const codeLock = buildLock(report, root);
      if (diskLock) notes.pending = diffLocks(diskLock, codeLock);
      headLock = codeLock;
    } catch (e) {
      const expected = expectedError(e);
      if (expected === undefined) console.error(internalError(e));
      notes.analysisError = expected ?? `internal error: ${printable(e instanceof Error ? e.message : String(e))}`;
    }
  }

  const changes = diffLocks(baseLock, headLock);
  notes.dependencies = dependencyChanges(base, args);
  notes.aiTools = aiTools;
  if (args.format === "json") {
    const p = notes.pending;
    const unrecorded = p && p.functions.length + p.unsafeAdded.length + p.unsafeRemoved.length + p.unsafeChanged.length > 0 ? p : null;
    const status = { analysisError: notes.analysisError ?? null, lockDeleted: notes.lockDeleted === true, baseLockMissing: notes.baseMissing === true };
    console.log(JSON.stringify({ base, head: args.head ?? "working tree", ...changes, via, unrecorded, ...status, dependencies: notes.dependencies, aiTools }, null, 2));
  } else {
    console.log(args.format === "markdown" ? formatDiffMarkdown(changes, via, notes) : formatDiffText(changes, via, notes));
  }
  return 0;
}

// --- helpers -----------------------------------------------------------------

/** Settings, files, and lock entries for one run. */
function analyze(args: Args): Report {
  const root = path.dirname(path.resolve(args.lock ?? DEFAULT_LOCK));
  const settings = settingsFor(args);
  const options: CheckOptions = {
    adapters: settings.adapters.map((a) => a.file),
    strictness: settings.strictness.value as Strictness,
    unmapped: settings.unmapped.value as UnmappedPolicy,
    tools: settings.tools.value as UnmappedPolicy,
    flows: settings.flows,
    // Workflows, Actions, and package.json scripts, from the folder the lock lives in.
    projectRoot: root,
  };
  const scope = settings.scope;
  const report = "project" in scope ? checkTsConfig(scope.project, options) : checkFiles(scope.paths.flatMap(expand), options);
  // What the check ran on and with is recorded in the lock, like what the code reaches.
  report.functions.push(...settingsEntries(settings, root));
  return report;
}

/**
 * The settings in effect: each command-line option, else the config file, else the default.
 * @throws UsageError or SettingsError for a value that isn't valid, or files that don't exist.
 */
function settingsFor(args: Args): Settings {
  const config = readConfig(args.config);
  const configName = config.file ?? args.config ?? DEFAULT_CONFIG;
  const pick = (option: string | undefined, fromConfig: unknown, fallback: string): { value: string; from: Origin } =>
    option !== undefined ? { value: option, from: "option" } : fromConfig !== undefined ? { value: String(fromConfig), from: "config" } : { value: fallback, from: "default" };

  if (config.strictness !== undefined && typeof config.strictness !== "string") {
    throw new UsageError(`${configName}: "strictness" must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  const strictness = pick(args.strictness, config.strictness, "development");
  if (!STRICTNESS_LEVELS.includes(strictness.value as Strictness)) throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  const unmapped = pick(args.unmapped, config.unmapped, "warn");
  if (!UNMAPPED_POLICIES.includes(unmapped.value as UnmappedPolicy)) throw new UsageError(`"unmapped" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);
  const tools = pick(undefined, config.tools, "warn");
  if (!UNMAPPED_POLICIES.includes(tools.value as UnmappedPolicy)) throw new UsageError(`"tools" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);

  let scope: Settings["scope"];
  if (args.project !== undefined) {
    readTsConfig(args.project);
    scope = { project: args.project, found: false };
  } else if (args.paths.length === 0 && existsSync("tsconfig.json")) {
    readTsConfig("tsconfig.json");
    scope = { project: "tsconfig.json", found: true };
  } else {
    const targets = args.paths.length > 0 ? args.paths : ["src"];
    const missing = targets.filter((p) => !existsSync(p));
    if (missing.length > 0) throw new UsageError(`Not found: ${missing.map(printable).join(", ")}`);
    scope = { paths: targets, given: args.paths.length > 0 };
  }
  return {
    configFile: path.resolve(configName),
    strictness,
    unmapped,
    tools,
    flows: config.flows ?? [],
    adapters: [...args.adapters.map((file) => ({ file: path.resolve(file), from: "option" as const })), ...config.adapters.map((file) => ({ file, from: "config" as const }))],
    scope,
  };
}

/** The lock file as committed at `ref`, or undefined if it didn't exist there. */
function lockAt(ref: string, lockFile: string): LockFile | undefined {
  const found = fileAt(ref, lockFile);
  return found && parseLock(found.text, found.spec);
}

/** A file's contents at a commit, or undefined when it doesn't exist there. */
function fileAt(ref: string, file: string): { text: string; spec: string } | undefined {
  // git resolves `ref:./path` relative to the working directory, so an absolute path is made relative.
  const relative = path.relative(process.cwd(), path.resolve(file)).replaceAll("\\", "/");
  const spec = `${ref}:./${relative}`;
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const failed = (e: unknown) => String((e as { stderr?: unknown }).stderr ?? "").trim() || (e as Error).message;
  // After --end-of-options, a ref that starts with "-" can't be read as an option.
  try {
    // First, that the commit is here: for a full hash it doesn't have, `git show` only says the file isn't in it.
    git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  } catch (e) {
    throw new UsageError(`Can't read ${file} at ${printable(ref)}: it isn't a commit in this repository (${printable(failed(e))}). Fetch it first.`);
  }
  try {
    return { text: git("show", "--end-of-options", spec), spec };
  } catch (e) {
    if (/does not exist|exists on disk, but not in/.test(failed(e))) return undefined;
    throw new UsageError(`Can't read ${file} at ${printable(ref)}: ${printable(failed(e))}`);
  }
}

/**
 * Packages the change adds to ./package.json, or installs from another source, for review.
 * Best effort: a missing or unreadable package.json means no dependency section, never a
 * failed diff, and adapters that can't be loaded leave only the built-in ones.
 */
function dependencyChanges(base: string, args: Args): DependencyChange[] {
  const parse = (text: string | undefined): PackageJson | undefined => {
    if (text === undefined) return undefined;
    try {
      const pkg: unknown = JSON.parse(text);
      return typeof pkg === "object" && pkg !== null && !Array.isArray(pkg) ? (pkg as PackageJson) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const head = parse(args.head ? fileAt(args.head, "package.json")?.text : existsSync("package.json") ? readFileSync("package.json", "utf8") : undefined);
    if (!head) return [];
    const installed = (name: string) => {
      const file = path.join("node_modules", name, "package.json");
      return existsSync(file) ? parse(readFileSync(file, "utf8")) : undefined;
    };
    return addedDependencies(parse(fileAt(base, "package.json")?.text), head, dependencyAdapters(args), installed);
  } catch (e) {
    if (expectedError(e) !== undefined) return [];
    throw e;
  }
}

function dependencyAdapters(args: Args): AdapterIndex {
  try {
    const loaded = loadAdapters([...args.adapters, ...readConfig(args.config).adapters]);
    if (loaded.errors.length === 0) return new AdapterIndex(loaded.adapters);
  } catch (e) {
    if (expectedError(e) === undefined) throw e;
  }
  return new AdapterIndex(loadAdapters([]).adapters);
}

function viaPaths(report: Report, root: string): ViaPaths {
  return Object.fromEntries(keyed(report, root).map(({ key, fn }) => [key, fn.via]));
}

/** A file's text. @throws UsageError when it can't be read (missing, a folder, no permission). */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`Can't read ${printable(file)}: ${printable((e as Error).message)}`);
  }
}

/** @throws UsageError when the file can't be written (no such folder, no permission). */
function writeText(file: string, text: string): void {
  try {
    writeFileSync(file, text);
  } catch (e) {
    throw new UsageError(`Can't write ${printable(file)}: ${printable((e as Error).message)}`);
  }
}

/** A file, or every TypeScript source under a directory (declaration files included, for their types). */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}
