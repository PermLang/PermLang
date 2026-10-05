// Built-in adapters for third-party packages, checked against stand-ins shaped like
// each package's real typings (the declaration a call resolves to decides which
// adapter entry applies). Each stand-in notes the version it was verified against.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";

// --- stand-ins for the packages, under node_modules ---------------------------------

const PACKAGES: Record<string, string> = {
  // @types/pg 8: the query methods are on classes.
  "pg/index.d.ts": `
export class Pool { query(text: string, values?: unknown[]): Promise<unknown>; end(): Promise<void>; }
export default { Pool };`,
};

// A team's own adapter, which adds to what PermLang detects itself.
const TEAM_ADAPTER = {
  permlang: 1,
  package: "pg",
  defines: ["audit.query"],
  functions: { "Pool.query": ["audit.query"] },
};

const SOURCES: Record<string, string> = {
  "team.ts": `
import { Pool } from "pg";
const pool = new Pool();
/** @perm env(NONE) */ export function leads() { return pool.query("SELECT * FROM leads"); }
`,
};

let root: string;
let report: Report;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "permlang-packages-"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, lib: ["ES2022", "DOM"], types: [] },
      include: ["src/*.ts"],
    }),
    "team-adapter.json": JSON.stringify(TEAM_ADAPTER),
  };
  for (const [file, text] of Object.entries(PACKAGES)) {
    const [name] = file.startsWith("@") ? [file.split("/").slice(0, 2).join("/")] : [file.split("/")[0]!];
    files[`node_modules/${file}`] = text;
    files[`node_modules/${name}/package.json`] ??= JSON.stringify({ name, types: "index.d.ts" });
  }
  for (const [file, text] of Object.entries(SOURCES)) files[`src/${file}`] = text;
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  report = checkTsConfig(path.join(root, "tsconfig.json"), { adapters: [path.join(root, "team-adapter.json")] });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What a function reaches, sorted. */
function actual(file: string, name: string): string[] {
  const fn = report.functions.find((f) => path.resolve(f.file) === path.join(root, "src", file) && f.name === name);
  expect(fn, `${file}:${name}`).toBeDefined();
  return [...fn!.actual].sort();
}

describe("adapters on top of built-in detection", () => {
  it("adds a team adapter's capabilities to a database client's tables", () => {
    expect(actual("team.ts", "leads")).toEqual(["audit.query", "db.read(leads)"]);
  });
});
