// Conformance suite: every fixture declares its expected diagnostics inline.
//
//   someCall(); // expect: error PERM001 net(data-broker.io)
//
// A fixture under pass/ must produce no diagnostics. A fixture under fail/ must
// declare at least one expectation, and must produce exactly the expected set.
// A fixture is a file, or a folder of files that import each other; a folder
// needs an expectation in at least one of its files.
//
// All fixtures are checked as one project, so each file must be a module (have
// an import or export) to keep its names out of the shared global scope.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkFiles, type Report } from "../src/check.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

const fixtureFiles = readdirSync(fixturesRoot, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(fixturesRoot, f))
  .sort();

const EXPECT = /expect:\s*(error|warning)\s+(PERM\d{3})\s+(\S+)/g;

function expectationsIn(file: string): string[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  return lines.flatMap((text, i) =>
    [...text.matchAll(EXPECT)].map(([, severity, code, capability]) => `${i + 1} ${severity} ${code} ${capability}`),
  );
}

let report: Report;

beforeAll(() => {
  report = checkFiles(fixtureFiles);
});

function actualFor(file: string): string[] {
  return report.diagnostics
    .filter((d) => path.resolve(d.file) === path.resolve(file))
    .map((d) => `${d.line} ${d.severity} ${d.code} ${d.capability}`);
}

describe("conformance fixtures", () => {
  it("finds fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  const cases = new Map<string, string[]>();
  for (const file of fixtureFiles) {
    // <milestone>/<pass|fail>/<case file or folder>/...
    const caseName = path.relative(fixturesRoot, file).replaceAll("\\", "/").split("/").slice(0, 3).join("/");
    cases.set(caseName, [...(cases.get(caseName) ?? []), file]);
  }

  for (const [caseName, files] of cases) {
    const kind = caseName.split("/")[1];

    it(caseName, () => {
      const expected = files.flatMap((f) => expectationsIn(f).map((e) => `${path.basename(f)}:${e}`));
      const actual = files.flatMap((f) => actualFor(f).map((a) => `${path.basename(f)}:${a}`));
      if (kind === "pass") expect(expected, "pass/ fixtures must not declare expectations").toEqual([]);
      if (kind === "fail") expect(expected.length, "fail/ fixtures must declare expectations").toBeGreaterThan(0);

      expect(actual.sort()).toEqual(expected.sort());
    });
  }
});

describe("diagnostic content", () => {
  it("every violation names the function and call, and suggests a fix", () => {
    const violations = report.diagnostics.filter((d) => d.code === "PERM001");
    expect(violations.length).toBeGreaterThan(0);
    for (const d of violations) {
      expect(d.function).not.toBe("");
      expect(d.call).not.toBe("");
      expect(d.message).toContain(d.function);
      expect(d.message).toContain(d.call);
      expect(d.fix).toMatch(/^add .+ to @perm, or remove the call\.$/);
      expect(d.column).toBeGreaterThan(0);
    }
  });

  const fn = (fixture: string, name: string) =>
    report.functions.find((f) => f.name === name && f.file === path.join(fixturesRoot, fixture).replaceAll("\\", "/"));

  it("reports declared and actual permissions for every function", () => {
    expect(fn("m1/fail/fetch-undeclared-host.ts", "handleLead")).toMatchObject({
      annotated: true,
      declared: ["db.write(leads)"],
      actual: ["net(data-broker.io)"],
    });
    expect(fn("m1/pass/class-method.ts", "StripeClient.charge")).toMatchObject({
      declared: ["net(api.stripe.com)"],
      actual: ["net(api.stripe.com)"],
    });
  });

  it("includes permissions reached through helpers, and module-level permissions", () => {
    expect(fn("m2/fail/deep-chain.ts", "a")).toMatchObject({ actual: ["fs.write(./public/dump.json)"] });
    expect(fn("m2/pass/module-level.ts", "authedBalance")).toMatchObject({
      declared: ["net(api.stripe.com)", "env(STRIPE_KEY)"],
    });
  });

  it("shows the call path for violations reached through helpers", () => {
    const d = report.diagnostics.find((x) => x.file.endsWith("m2/fail/deep-chain.ts") && x.code === "PERM001");
    expect(d?.path).toEqual(["b", "c", 'writeFileSync("./public/dump.json", ...)']);
    expect(d?.message).toContain("b → c → writeFileSync");
  });
});
