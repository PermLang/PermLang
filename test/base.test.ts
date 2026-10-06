// `permlang check --base <ref>`, which the Action runs on pull requests and merge-queue entries:
// the base commit decides whether the lock file is required, and a change can't leave the base's
// lock behind by pointing the Action at another lock file or folder (found by the second
// verification: a pull request that changed `args` to `--lock permlang.lock.v2.json` passed with
// new access, and the comment said only that the base had no such file).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

let dir: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const permlang = (cwd: string, ...args: string[]) => runCli(args, { cwd: path.join(dir, cwd), env: { GITHUB_WORKSPACE: dir } });

function write(file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

/** A workflow that runs the PermLang Action once for each step's inputs. */
function workflow(file: string, ...steps: Record<string, string>[]) {
  const lines = ["on: pull_request", "jobs:", "  permissions:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v7"];
  for (const { uses = "PermLang/permlang@v0", ...inputs } of steps) {
    lines.push(`      - uses: ${uses}`);
    if (Object.keys(inputs).length > 0) lines.push("        with:", ...Object.entries(inputs).map(([k, v]) => `          ${k}: ${v}`));
  }
  write(`.github/workflows/${file}`, `${lines.join("\n")}\n`);
}

/** A project at sketch strictness, so only the lock decides. */
function app(folder: string, host = "api.example.com") {
  write(`${folder}/src/app.ts`, `export async function ping() {\n  return fetch("https://${host}/");\n}\n`);
  write(`${folder}/permlang.config.json`, `{ "strictness": "sketch" }\n`);
}

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-base-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("permlang check --base", () => {
  it("requires the lock the base commit has, and passes when nothing moved", () => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    expect(permlang(".", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    rmSync(path.join(dir, "permlang.lock.json"));
    const { code, out } = permlang(".", "check", "src", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain("error PERM005: permlang.lock.json is missing.");
    expect(permlang(".", "check", "src", "--no-lock", "--base", base)).toMatchObject({ code: 2, out: expect.stringMatching(/^--no-lock turns off the comparison with permlang\.lock\.json, which the base commit has\./) });
  });

  it("fails a change that points the Action at a new lock file", () => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    // The pull request: new access, approved in a lock file of its own.
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --lock permlang.lock.v2.json" });
    permlang(".", "lock", "src", "--lock", "permlang.lock.v2.json");
    const { code, out } = permlang(".", "check", "src", "--lock", "permlang.lock.v2.json", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain(
      "permlang.lock.v2.json:1:1 error PERM005: This change stops checking with permlang.lock.json, which the base commit's workflow checks with, and this check reads permlang.lock.v2.json instead.",
    );
    // The comment says so too.
    const md = permlang(".", "diff", base, "src", "--lock", "permlang.lock.v2.json", "--format", "markdown").out;
    expect(md).toContain("**This pull request stops checking with <code>permlang.lock.json</code>**");
    // Without --base, nothing is known of the base, as before.
    expect(permlang(".", "check", "src", "--lock", "permlang.lock.v2.json").code).toBe(0);
  });

  it("fails a change that runs the Action in a folder with no lock at the base", () => {
    app("app");
    workflow("permlang.yml", { "working-directory": "app", args: "src" });
    permlang("app", "lock", "src");
    const base = commit("base");
    // Moved to a new folder, with a lock of its own.
    git("mv", "app", "app2");
    app("app2", "api.data-broker.example");
    workflow("permlang.yml", { "working-directory": "app2", args: "src" });
    permlang("app2", "lock", "src");
    const { code, out } = permlang("app2", "check", "src", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain("This change stops checking with app/permlang.lock.json");
  });

  it("fails a change to a lock file the base has but doesn't check with", () => {
    // A lock file added earlier, unused, and then switched to.
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    app(".", "api.data-broker.example");
    permlang(".", "lock", "src", "--lock", "spare.json");
    app(".");
    const base = commit("base");
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --lock spare.json" });
    expect(permlang(".", "check", "src", "--lock", "spare.json", "--base", base)).toMatchObject({ code: 1, out: expect.stringContaining("stops checking with permlang.lock.json") });
  });

  it("finds the base's lock in any workflow, and in PermLang's own repository's `uses: ./`", () => {
    write("action.yml", "name: PermLang\nruns:\n  using: composite\n  steps: []\n");
    app(".");
    workflow("self.yml", { uses: "./", args: "src --lock checked.json" });
    permlang(".", "lock", "src", "--lock", "checked.json");
    const base = commit("base");
    // Renamed workflow, other lock.
    rmSync(path.join(dir, ".github", "workflows", "self.yml"));
    workflow("renamed.yml", { uses: "./", args: "src --lock other.json" });
    permlang(".", "lock", "src", "--lock", "other.json");
    expect(permlang(".", "check", "src", "--lock", "other.json", "--base", base).out).toContain("stops checking with checked.json");
  });

  it("takes permlang.lock.json in this folder as the base's lock when the base's workflows don't say", () => {
    app(".");
    // No workflow, or one whose inputs come from an expression (here, what --lock names isn't the lock).
    workflow("matrix.yml", { args: "${{ matrix.args }} --lock unused.json" });
    permlang(".", "lock", "src");
    permlang(".", "lock", "src", "--lock", "unused.json");
    const base = commit("base");
    permlang(".", "lock", "src", "--lock", "other.json");
    expect(permlang(".", "check", "src", "--lock", "other.json", "--base", base).out).toContain("stops checking with permlang.lock.json");
    expect(permlang(".", "check", "src", "--base", base).code).toBe(0);
  });

  it("lets a monorepo add a package, and move a lock in two steps", () => {
    app("web");
    workflow("permlang.yml", { "working-directory": "web", args: "src" });
    permlang("web", "lock", "src");
    const base = commit("base");
    // A new package, with its own step and lock: the base's lock is still checked with.
    app("api");
    workflow("permlang.yml", { "working-directory": "web", args: "src" }, { "working-directory": "api", args: "src" });
    permlang("api", "lock", "src");
    expect(permlang("api", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    expect(permlang("web", "check", "src", "--base", base)).toMatchObject({ code: 0 });

    // Moving web's lock: first a step that reads the new one next to the old...
    workflow("permlang.yml", { "working-directory": "web", args: "src" }, { "working-directory": "web", args: "src --lock next.json" });
    permlang("web", "lock", "src", "--lock", "next.json");
    expect(permlang("web", "check", "src", "--lock", "next.json", "--base", base)).toMatchObject({ code: 0 });
    const both = commit("both");
    // ...then, once that's merged, dropping the old one.
    workflow("permlang.yml", { "working-directory": "web", args: "src --lock next.json" });
    expect(permlang("web", "check", "src", "--lock", "next.json", "--base", both)).toMatchObject({ code: 0 });
  });

  it("ignores other Actions, and steps it can't read", () => {
    app(".");
    workflow("permlang.yml", { args: "src" }, { uses: "someone/permlang@v1", args: "--lock elsewhere.json" }, { args: "src --frob" });
    permlang(".", "lock", "src");
    permlang(".", "lock", "src", "--lock", "elsewhere.json");
    const base = commit("base");
    expect(permlang(".", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    // Another Action's --lock isn't a lock PermLang checks with.
    workflow("permlang.yml", { args: "src --lock elsewhere.json" }, { uses: "someone/permlang@v1", args: "--lock elsewhere.json" });
    expect(permlang(".", "check", "src", "--lock", "elsewhere.json", "--base", base).out).toContain("stops checking with permlang.lock.json");
  });

  it("is a usage error when the base isn't a commit here", () => {
    app(".");
    permlang(".", "lock", "src");
    commit("base");
    expect(permlang(".", "check", "src", "--base", "1".repeat(40))).toMatchObject({ code: 2, out: expect.stringMatching(/isn't a commit in this repository; fetch it first/) });
  });
});
