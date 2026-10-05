// Globals whose types come from somewhere other than lib.dom: Node's web globals (typed by
// undici-types), `process` when Node's types are missing, and Vite's import.meta.env. Each
// runs as its own project, since the shared fixtures have both lib.dom and @types/node.
// Found in the 0.3 review.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

function check(compilerOptions: object, files: Record<string, string>): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-globals-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, typeRoots, ...compilerOptions },
    include: ["*.ts"],
  }));
  for (const [name, code] of Object.entries(files)) writeFileSync(path.join(dir, name), code);
  return checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const errors = (report: Report, fn: string) =>
  report.diagnostics.filter((d) => d.function === fn && d.severity === "error").map((d) => `${d.code} ${d.capability}`);

describe("Node's web globals, without lib.dom", () => {
  const report = check({ lib: ["ES2022"], types: ["node"] }, {
    "app.ts": [
      "/** @perm env(MODE) */",
      "export function ws() { return new WebSocket(\"wss://evil.example/x\"); }",
      "/** @perm env(MODE) */",
      "export function wsAlias() { const W = WebSocket; return new W(\"wss://evil.example/x\"); }",
      "/** @perm env(MODE) */",
      "export async function web() { const r = new Response(\"x\"); return [new Headers({ a: \"b\" }).get(\"a\"), await r.text(), new Request(\"https://good.example/\").url, new FormData()]; }",
    ].join("\n"),
  });

  it("finds WebSocket, also through an alias", () => {
    expect(errors(report, "ws")).toEqual(["PERM001 net(evil.example)"]);
    expect(errors(report, "wsAlias")).toEqual(["PERM001 net(evil.example)"]);
  });

  it("maps undici-types, so Headers, Request, and Response aren't unmapped", () => {
    expect(errors(report, "web")).toEqual([]);
    expect(report.unmapped.map((u) => u.package)).not.toContain("undici-types");
    expect(report.diagnostics.filter((d) => d.code === "PERM006")).toEqual([]);
  });
});

describe("process without Node's types", () => {
  const report = check({ lib: ["ES2022"], types: [] }, {
    "app.ts": [
      "/** @perm env(STRIPE_KEY) */",
      "export function key() { return process.env.STRIPE_KEY; }",
      "/** @perm env(STRIPE_KEY) */",
      "export function other() { return process.env[\"OTHER\"]; }",
      "/** @perm env(STRIPE_KEY) */",
      "export function stop() { process.kill(1); }",
    ].join("\n"),
  });

  it("still reads environment variables by name", () => {
    expect(errors(report, "key")).toEqual([]);
    expect(errors(report, "other")).toEqual(["PERM001 env(OTHER)"]);
  });

  it("warns that the rest of process can't be checked", () => {
    const d = report.diagnostics.filter((x) => x.code === "PERM007");
    expect(d.map((x) => `${x.severity} ${x.capability} ${x.line}`)).toEqual(["warning node:process 2"]);
    expect(d[0]!.fix).toBe("install @types/node.");
    expect(report.unresolved).toEqual(["node:process"]);
  });

  it("reads a project's own `declare const process` the same way, without the warning", () => {
    const shimmed = check({ lib: ["ES2022"], types: [] }, {
      "shim.d.ts": "declare const process: { env: Record<string, string | undefined> };",
      "app.ts": "/** @perm env(A) */\nexport function b() { return process.env.B; }",
    });
    expect(errors(shimmed, "b")).toEqual(["PERM001 env(B)"]);
    expect(shimmed.unresolved).toEqual([]);
  });
});

describe("import.meta.env", () => {
  const files = {
    "app.ts": [
      "/** @perm env(VITE_API_URL) */",
      "export function url() { return import.meta.env.VITE_API_URL; }",
      "/** @perm env(VITE_API_URL) */",
      "export function secret() { return import.meta.env.VITE_SECRET_KEY; }",
      "/** @perm env(VITE_API_URL) */",
      "export function mode() { return import.meta.env.DEV ? import.meta.env.MODE : \"\"; }",
      "/** @perm env(VITE_API_URL) */",
      "export function whole() { return { ...import.meta.env }; }",
      "/** @perm env(VITE_API_URL) */",
      "export function alias() { const env = import.meta.env; return env.VITE_TOKEN; }",
    ].join("\n"),
  };
  // What vite/client declares.
  const viteTypes = "interface ImportMetaEnv { readonly [key: string]: any; BASE_URL: string; MODE: string; DEV: boolean; PROD: boolean; SSR: boolean }\ninterface ImportMeta { readonly env: ImportMetaEnv }";

  for (const [name, report] of [
    ["with Vite's types", check({ lib: ["ES2022", "DOM"], types: [] }, { ...files, "env.d.ts": viteTypes })],
    ["without types", check({ lib: ["ES2022", "DOM"], types: [] }, files)],
  ] as const) {
    describe(name, () => {
      it("reads variables by name", () => {
        expect(errors(report, "url")).toEqual([]);
        expect(errors(report, "secret")).toEqual(["PERM001 env(VITE_SECRET_KEY)"]);
        expect(errors(report, "whole")).toEqual(["PERM001 env"]);
      });

      it("ignores what Vite sets itself (MODE, DEV, PROD, SSR, BASE_URL)", () => expect(errors(report, "mode")).toEqual([]));

      it("follows an alias, or reads every variable through one it can't follow", () => {
        expect(errors(report, "alias")).toEqual([name === "without types" ? "PERM001 env" : "PERM001 env(VITE_TOKEN)"]);
      });
    });
  }
});
