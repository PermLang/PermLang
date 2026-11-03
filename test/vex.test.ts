// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// permlang.openvex.json says some vulnerabilities in PermLang's dependencies can't affect it,
// because their code never runs in PermLang's use of the package. Each such statement is
// checked here: the code is replaced by a function that records every call, PermLang checks
// some projects, and nothing may have called it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles, checkTsConfig } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

interface Statement {
  vulnerability: { name: string };
  products: { "@id": string }[];
  status: string;
  justification?: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const vex = JSON.parse(readFileSync(path.join(root, "permlang.openvex.json"), "utf8")) as { statements: Statement[] };
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const typeRoots = [path.join(root, "node_modules", "@types")];
const dirs: string[] = [];

afterAll(() => dirs.forEach(removeTemporary));

function statement(name: string): Statement | undefined {
  return vex.statements.find((s) => s.vulnerability.name === name);
}

/** Every call of `module[name]` while `run` runs, with the module's own function put back after. */
function callsOf(module: Record<string, unknown>, name: string, run: () => void): unknown[][] {
  const original = module[name] as (...args: unknown[]) => unknown;
  const calls: unknown[][] = [];
  module[name] = (...args: unknown[]) => {
    calls.push(args);
    return original(...args);
  };
  try {
    run();
  } finally {
    module[name] = original;
  }
  return calls;
}

describe("GHSA-g3hv-75wg-m249: minimatch's pattern expansion", () => {
  // The copy of minimatch that ts-morph loads.
  const fromTsMorph = createRequire(createRequire(import.meta.url).resolve("@ts-morph/common"));
  const minimatch = fromTsMorph("minimatch") as Record<string, unknown>;

  it("is stated not to affect this version", () => {
    const s = statement("GHSA-g3hv-75wg-m249");
    expect(s?.status).toBe("not_affected");
    expect(s?.justification).toBe("vulnerable_code_not_in_execute_path");
    expect(s?.products.map((p) => p["@id"])).toContain(`pkg:npm/permlang@${version}`);
  });

  it("would be seen if ts-morph called it", () => {
    // ts-morph matches patterns with minimatch for an in-memory file system, and in getSourceFiles(patterns).
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/app/a.ts", "export {};");
    const calls = callsOf(minimatch, "minimatch", () => {
      expect(project.getSourceFiles("/app/*.ts").map((f) => f.getFilePath())).toEqual(["/app/a.ts"]);
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("never runs when PermLang checks files, folders' files, patterns, or a tsconfig.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "permlang-vex-"));
    dirs.push(dir);
    const files = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", types: ["node"], typeRoots }, include: ["src/**/*.ts"] }),
      "src/a.ts": 'import { readFileSync } from "node:fs";\nimport { b } from "./lib/b.js";\nexport function a() { return readFileSync("./x") + b(); }\n',
      "src/lib/b.ts": 'export function b() { return fetch("https://example.com"); }\n',
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    const fixtures = path.join(root, "fixtures", "m1", "fail");
    const calls = callsOf(minimatch, "minimatch", () => {
      expect(checkTsConfig(path.join(dir, "tsconfig.json")).diagnostics.length).toBeGreaterThan(0);
      expect(checkFiles([path.join(dir, "src", "a.ts")]).diagnostics.length).toBeGreaterThan(0);
      // A path that isn't a file goes to ts-morph as a pattern.
      expect(checkFiles([`${fixtures.replaceAll("\\", "/")}/fs-*.ts`]).diagnostics.length).toBeGreaterThan(0);
    });
    expect(calls).toEqual([]);
  });
});
