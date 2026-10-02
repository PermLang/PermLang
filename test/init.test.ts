// `permlang init`: the day-one setup for an existing project. Runs the real CLI
// in a temporary directory.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    return { code: 0, out: execFileSync(process.execPath, [tsx, cli, ...args], { cwd: dir, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-init-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), `export async function ping() {\n  return fetch("https://api.example.com/");\n}\n`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("permlang init", () => {
  it("writes a sketch config and a lock, and the check then passes", () => {
    const { code, out } = permlang("init", "src");
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.config.json"), "utf8"))).toEqual({ strictness: "sketch" });
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.lock.json"), "utf8")).functions).toEqual({
      "src/app.ts#ping": ["net(api.example.com)"],
    });
    expect(out).toMatch(/Next steps/);
    // Sketch still fails on access the lock doesn't record, so init mustn't say nothing fails.
    expect(out).toContain("new access the lock file doesn't record still fails");
    expect(out).not.toMatch(/nothing fails/);
    expect(permlang("check", "src").code).toBe(0);
  });

  it("keeps an existing config", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), `{ "strictness": "production" }\n`);
    const { out } = permlang("init", "src");
    expect(readFileSync(path.join(dir, "permlang.config.json"), "utf8")).toBe(`{ "strictness": "production" }\n`);
    expect(out).toMatch(/Kept permlang\.config\.json/);
  });

  it("adds the GitHub workflow on request, with the same source selection", () => {
    permlang("init", "src", "--workflow");
    const workflow = readFileSync(path.join(dir, ".github", "workflows", "permlang.yml"), "utf8");
    expect(workflow).toContain("uses: PermLang/permlang@v0");
    expect(workflow).toContain("args: src");
    expect(workflow).toContain("pull-requests: write");
  });

  it("doesn't write the workflow unless asked", () => {
    permlang("init", "src");
    expect(existsSync(path.join(dir, ".github"))).toBe(false);
  });

  it("then fails the check when new access appears", () => {
    permlang("init", "src");
    writeFileSync(path.join(dir, "src", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    const { code, out } = permlang("check", "src");
    expect(code).toBe(1);
    expect(out).toMatch(/PERM005: ping can now reach net\(data-broker\.io\)/);
  });
});
