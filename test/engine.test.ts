// Engine behaviour that needs a project of its own: package boundaries for declaration
// files, reusing a ts-morph Project, very long call chains, and very deep expressions.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

/** Writes `files` into a new folder with a tsconfig.json, and returns that tsconfig's path. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-engine-"));
  dirs.push(dir);
  const tsconfig = {
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots },
    include: ["src"],
  };
  for (const [file, text] of Object.entries({ "tsconfig.json": JSON.stringify(tsconfig), ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return path.join(dir, "tsconfig.json");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const errors = (report: Report, file: string) =>
  report.diagnostics.filter((d) => d.severity === "error" && d.file.endsWith(file)).map((d) => `${d.line} ${d.code} ${d.capability}`);

describe("declaration files for the project's own JavaScript", () => {
  it("are unverifiable inside the project's package, but not in a package of their own", () => {
    const report = checkTsConfig(project({
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      // Hand-written types for the project's own legacy.js.
      "src/legacy.d.ts": "export declare function run(cmd: string): string;\n",
      // A generated client in its own package (as Prisma's custom output is): a dependency, not the project's code.
      "src/generated/client/package.json": JSON.stringify({ name: "prisma-client-generated" }),
      "src/generated/client/index.d.ts": "export declare class PrismaClient { $connect(): Promise<void>; }\n",
      "src/app.ts": [
        'import { run } from "./legacy.js";',
        'import { PrismaClient } from "./generated/client/index.js";',
        "/** @perm env(MODE) */",
        "export async function t() {",
        "  await new PrismaClient().$connect();",
        "  return run(process.env.MODE ?? \"\");",
        "}",
      ].join("\n"),
    }));
    expect(errors(report, "app.ts")).toEqual(["6 PERM004 unverifiable"]);
    // The declarations themselves aren't functions PermLang analyzed, so they aren't reported or locked.
    expect(report.functions.map((f) => f.name)).toEqual(["t"]);
    expect(report.diagnostics.find((d) => d.code === "PERM004")?.message).toMatch(/reaching run → JavaScript declared in legacy\.d\.ts\n/);
  });
});

describe("suggested fixes", () => {
  it("point at something an annotation attaches to", () => {
    const report = checkTsConfig(project({
      "src/app.ts": [
        'import { execSync } from "node:child_process";',
        'execSync("ls");',
        "export class Loader {",
        '  data = fetch("https://loader.example/");',
        "}",
        "eval(\"1\");",
      ].join("\n"),
    }));
    const fix = (code: string, capability: string) => report.diagnostics.find((d) => d.code === code && d.capability === capability)?.fix;
    expect(fix("PERM003", "exec")).toBe("add /** @module @perm exec */ at the top of the file.");
    expect(fix("PERM003", "net(loader.example)")).toBe("add /** @perm net(loader.example) */ above class Loader.");
    expect(fix("PERM004", "unverifiable")).toBe("rewrite it so what it calls is known statically, or move it into a function marked @perm-unsafe with a reason.");
  });
});
