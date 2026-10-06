// The permlang command's arguments: which options each command takes, and what they mean.
// Kept apart from main.ts so that reading the Action's `args` in a workflow (action-steps.ts)
// parses them exactly as the command would.

import { printable } from "./report.js";

export const USAGE = `Usage:
  permlang --version                     print the version
  permlang init  [paths...] [options]    set up: a sketch-level config and a first lock file
  permlang check [paths...] [options]    check permissions (and the lock file, if there is one)
  permlang lock  [paths...] [options]    write permlang.lock.json from the current code
  permlang diff  [base-ref] [paths...]   permission changes since base-ref (default HEAD)
  permlang spec  [paths...] [options]    check .perm specs against the code (phase 2 groundwork)

Which files: paths, or --project <tsconfig.json>. With neither, ./tsconfig.json
if present, else ./src. The project's own files they import are checked too.

Options:
  --project, -p <tsconfig.json>   check the files of a TypeScript project
  --config <file>                 config file (default: ./permlang.config.json if present)
  --adapter <file.json>           add an adapter manifest (repeatable)
  --strictness <level>            sketch | development | production (default: development)
  --unmapped <policy>             packages with no adapter: warn | error | trust (default: warn)
  --lock <file>                   lock file (default: ./permlang.lock.json)
  --no-lock                       check: don't compare against the lock file
  --require-lock                  check: fail when the lock file is missing
  --base <ref>                    check: the change's base commit. Fail when it has the lock file
                                  and the working tree doesn't, or when its workflows check with
                                  a lock file this check doesn't read (the Action passes it)
  --json                          check, spec: print the JSON report (diff: same as --format json)
  --github-annotations            check: also print a GitHub Actions annotation per diagnostic
                                  (on standard error with --json, so the JSON stays valid)
  --sarif <file>                  check: also write the findings as SARIF, for GitHub code scanning
  --head <ref>                    diff: compare against this commit instead of the working tree
  --format <text|markdown|json>   diff: output format (default: text)
  --summary <file>                diff: also write the markdown diff, uncut, for a job summary
  --workflow                      init: also add .github/workflows/permlang.yml
  --spec <file.perm>              spec: check this spec (repeatable; default: every .perm file here)

diff also takes check's options except --base, so one set of arguments works for both
(the Action passes its args to each); --require-lock, --sarif, and --github-annotations
don't change the diff.

permlang.config.json:
  { "strictness": "sketch", "unmapped": "warn", "adapters": ["./permlang/adapters/acme-sms.json"] }
  Also "tools": "warn" | "error" | "trust", and "flows": [{ "from": "env(KEY)", "to": ["net(host)"] }].

The lock file records which files were checked, and the settings in effect (options
included): check with the same paths and options it was written with.

Exit codes: 0 no errors, 1 permission errors, 2 anything else (a usage or configuration
error, a file that can't be read or written, or an internal error).`;

export const DEFAULT_LOCK = "permlang.lock.json";

export const COMMANDS = ["init", "check", "lock", "diff", "spec"] as const;
export type Command = (typeof COMMANDS)[number];

export class UsageError extends Error {}

export interface Args {
  paths: string[];
  adapters: string[];
  project?: string;
  config?: string;
  strictness?: string;
  unmapped?: string;
  lock?: string;
  noLock: boolean;
  requireLock: boolean;
  base?: string;
  workflow: boolean;
  specs: string[];
  json: boolean;
  githubAnnotations: boolean;
  sarif?: string;
  head?: string;
  format?: string;
  summary?: string;
}

/** Options that choose the files and settings: every command takes them. */
const SETTINGS = ["--project", "-p", "--config", "--adapter", "--strictness", "--unmapped", "--lock"];
const CHECK = [...SETTINGS, "--no-lock", "--require-lock", "--base", "--json", "--github-annotations", "--sarif"];
/** check's options that diff takes but that don't change it. */
const IGNORED_BY_DIFF = new Set(["--require-lock", "--github-annotations", "--sarif"]);

/**
 * The options each command takes. Any other is a usage error, so an option meant for another
 * command can't be ignored without a word: `check --format json` would print text and pass,
 * and `check --head` would leave the check alone while changing what the Action's comment
 * compares. diff takes check's options (except --base: its base is its first argument), since
 * the Action passes the same arguments to both.
 */
const TAKES: Record<Command, ReadonlySet<string>> = {
  init: new Set([...SETTINGS, "--workflow"]),
  check: new Set(CHECK),
  lock: new Set(SETTINGS),
  diff: new Set([...CHECK.filter((o) => o !== "--base"), "--head", "--format", "--summary"]),
  spec: new Set([...SETTINGS, "--json", "--spec"]),
};

/** Options followed by a value. */
const VALUED = new Set(["--project", "-p", "--config", "--adapter", "--strictness", "--unmapped", "--lock", "--base", "--sarif", "--head", "--format", "--summary", "--spec"]);

/** @throws UsageError for an option the command doesn't take, or one missing its value. */
export function parseArgs(command: Command, rest: readonly string[]): Args {
  const args: Args = { paths: [], adapters: [], specs: [], noLock: false, requireLock: false, workflow: false, json: false, githubAnnotations: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("-")) {
      args.paths.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") throw new UsageError(`${arg} goes on its own: \`permlang ${command} --help\`.`);
    if (!TAKES[command].has(arg)) throw new UsageError(misplaced(command, arg));
    let v = "";
    if (VALUED.has(arg)) {
      v = rest[++i] ?? "";
      // A value that's another option is a mistake (`--format --lock x`), and reading it as a value
      // would hide the option it names.
      if (v === "" || v.startsWith("-")) throw new UsageError(`${arg} needs a value${v ? `, not the option "${printable(v)}"` : ""}.`);
    }
    if (arg === "--json") args.json = true;
    else if (arg === "--github-annotations") args.githubAnnotations = true;
    else if (arg === "--no-lock") args.noLock = true;
    else if (arg === "--require-lock") args.requireLock = true;
    else if (arg === "--workflow") args.workflow = true;
    else if (arg === "--sarif") args.sarif = v;
    else if (arg === "--base") args.base = v;
    else if (arg === "--spec") args.specs.push(v);
    else if (arg === "--project" || arg === "-p") args.project = v;
    else if (arg === "--config") args.config = v;
    else if (arg === "--adapter") args.adapters.push(v);
    else if (arg === "--strictness") args.strictness = v;
    else if (arg === "--unmapped") args.unmapped = v;
    else if (arg === "--lock") args.lock = v;
    else if (arg === "--head") args.head = v;
    else if (arg === "--format") args.format = v;
    else if (arg === "--summary") args.summary = v;
  }
  return args;
}

/** Why `command` doesn't take `option`, naming the one it takes instead when there is one. */
function misplaced(command: Command, option: string): string {
  const takers = COMMANDS.filter((c) => TAKES[c].has(option) && !(c === "diff" && IGNORED_BY_DIFF.has(option)));
  if (takers.length === 0) return `Unknown option "${printable(option)}".\n\n${USAGE}`;
  if (option === "--format" && TAKES[command].has("--json")) return `${command} takes --json, not --format: \`permlang ${command} --json\`.`;
  if (option === "--base" && command === "diff") return "diff takes the base commit as its first argument, not --base: `permlang diff <base-ref>`.";
  const list = takers.length === 1 ? takers[0] : `${takers.slice(0, -1).join(", ")} and ${takers.at(-1)}`;
  return `${command} doesn't take ${option}: it's an option of ${list}.`;
}
