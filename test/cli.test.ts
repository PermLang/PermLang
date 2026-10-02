// CLI edge cases from the pre-release review. Runs the real CLI in a temporary
// git repository whose code isn't in ./src.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(repo, "src", "cli.ts");

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [tsx, cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-cli-"));
  mkdirSync(path.join(dir, "my lib"));
  writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://api.example.com/");\n}\n`);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("permlang diff", () => {
  it("analyzes the given paths, not ./src", () => {
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    expect(permlang("lock", "my lib").code).toBe(0);

    const { code, out } = permlang("diff", "HEAD", "my lib", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("<code>+ net(data-broker.io)</code>");
    expect(out).toContain("fetch(&quot;https://data-broker.io/&quot;)");
  });

  it("still prints the diff when the code can't be analyzed for paths", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("No permission changes");
  });

  it("shows access the lock doesn't record yet, so a PR that skips `permlang lock` isn't reported as clean", () => {
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // An AI-style change: new network access, lock file left untouched.
    writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "change without lock");

    const md = permlang("diff", "HEAD~1", "my lib", "--format", "markdown");
    expect(md.code).toBe(0);
    expect(md.out).toContain("Not approved yet");
    expect(md.out).toContain("<code>+ net(data-broker.io)</code>");
    expect(md.out).not.toContain("No permission changes");

    const json = JSON.parse(permlang("diff", "HEAD~1", "my lib", "--format", "json").out) as { unrecorded: unknown };
    expect(json.unrecorded).not.toBeNull();

    // Once the lock is updated, the warning goes away and the access is still listed.
    expect(permlang("lock", "my lib").code).toBe(0);
    const approved = permlang("diff", "HEAD~1", "my lib", "--format", "markdown").out;
    expect(approved).not.toContain("Not approved yet");
    expect(approved).toContain("<code>+ net(data-broker.io)</code>");
  });

  it("accepts an absolute --lock path", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--lock", path.join(dir, "permlang.lock.json"));
    expect(out).toContain("No permission changes");
    expect(code).toBe(0);
  });
});

describe("configuration errors", () => {
  it("exits 2 on a config file that isn't an object", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), "null\n");
    const { code, out } = permlang("check", "my lib");
    expect(code).toBe(2);
    expect(out).toMatch(/permlang\.config\.json.*object/);
  });
});

describe("permlang check --github-annotations", () => {
  it("adds a GitHub annotation on the line of each diagnostic, after the usual report", () => {
    const { code, out } = permlang("check", "my lib", "--no-lock", "--github-annotations");
    expect(code).toBe(1);
    expect(out).toContain("my lib/app.ts:2:10 error PERM003");
    expect(out).toMatch(/^::error file=my lib\/app\.ts,line=2,col=10,title=PermLang PERM003%3A net\(api\.example\.com\)::ping calls fetch/m);
    // Without the option, no workflow commands.
    expect(permlang("check", "my lib", "--no-lock").out).not.toContain("::error");
  });
});

describe("help", () => {
  it("prints usage for a subcommand's --help instead of an unknown-option error", () => {
    for (const command of ["check", "lock", "diff", "init", "spec"]) {
      const { code, out } = permlang(command, "--help");
      expect(code).toBe(0);
      expect(out).toContain("Usage:");
      expect(out).not.toContain("Unknown option");
    }
  });
});

describe("permlang --version", () => {
  it("prints the package version", () => {
    const { version } = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) expect(permlang(flag)).toEqual({ code: 0, out: `${version}\n` });
  });
});
