// A module's exported constants, read by name in other files, are fixed only where the module's
// namespace object is: in CommonJS, `import * as config` is the module's `exports` object, so
// writing to it changes what every importer reads; an ES module's namespace can't be written.
// Each runs as its own project, since the module format is a compiler option.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const dirs: string[] = [];

function check(compilerOptions: object, files: Record<string, string>): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-constants-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", strict: true, lib: ["ES2022", "DOM"], types: [], ...compilerOptions },
    include: ["*.ts"],
  }));
  for (const [name, code] of Object.entries(files)) writeFileSync(path.join(dir, name), code);
  return checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}

afterAll(() => dirs.forEach(removeTemporary));

const errors = (report: Report, fn: string) =>
  report.diagnostics.filter((d) => d.function === fn && d.severity === "error").map((d) => `${d.code} ${d.capability}`);

const files = {
  "config.ts": "export const API_URL = \"https://good.example/collect\";\nexport const ROUTES = { api: \"https://good.example/api\" } as const;",
  "poison.ts": "import * as config from \"./config\";\n// Runs when imported, and changes the constants for every importer.\nObject.assign(config, { API_URL: \"https://evil.example/collect\", ROUTES: { api: \"https://evil.example/api\" } });\nexport {};",
  "app.ts": "import \"./poison\";\nimport { API_URL, ROUTES } from \"./config\";\n/** @perm net(good.example) */\nexport function send() { return fetch(API_URL); }\n/** @perm net(good.example) */\nexport function route() { return fetch(ROUTES.api); }",
  "kept.ts": "export const KEPT_URL = \"https://good.example/kept\";",
  "reader.ts": "import * as kept from \"./kept\";\n/** @perm net(good.example) */\nexport function read() { return [fetch(kept.KEPT_URL), Object.keys(kept)]; }",
};

describe("constants exported from a CommonJS module", () => {
  const report = check({ module: "commonjs", moduleResolution: "node10" }, files);

  it("are unknown once another file writes to the module's exports", () => {
    expect(errors(report, "send")).toEqual(["PERM001 net"]);
    expect(errors(report, "route")).toEqual(["PERM001 net"]);
  });

  it("are still read from a module whose exports nothing writes", () => expect(errors(report, "read")).toEqual([]));
});

describe("constants exported from an ES module", () => {
  // Object.assign on an ES module's namespace throws, so the constants keep their values.
  const report = check({ module: "esnext", moduleResolution: "bundler" }, files);

  it("are read as written", () => {
    expect(errors(report, "send")).toEqual([]);
    expect(errors(report, "route")).toEqual([]);
    expect(errors(report, "read")).toEqual([]);
  });
});
