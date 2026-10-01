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

describe("permlang --version", () => {
  it("prints the package version", () => {
    const { version } = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) expect(permlang(flag)).toEqual({ code: 0, out: `${version}\n` });
  });
});
