// Conformance suite: every fixture declares its expected diagnostics inline.
//
//   someCall(); // expect: error PERM001 net(data-broker.io)
//
// A fixture under pass/ must produce no diagnostics. A fixture under fail/ must
// declare at least one expectation, and must produce exactly the expected set.

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

  for (const file of fixtureFiles) {
    const name = path.relative(fixturesRoot, file).replaceAll("\\", "/");
    const kind = name.split("/")[1];

    it(name, () => {
      const expected = expectationsIn(file);
      if (kind === "pass") expect(expected, "pass/ fixtures must not declare expectations").toEqual([]);
      if (kind === "fail") expect(expected.length, "fail/ fixtures must declare expectations").toBeGreaterThan(0);

      expect(actualFor(file).sort()).toEqual(expected.sort());
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

  it("reports declared and actual permissions for every function", () => {
    const fn = report.functions.find((f) => f.name === "handleLead");
    expect(fn).toMatchObject({
      annotated: true,
      declared: ["db.write(leads)"],
      actual: ["net(data-broker.io)"],
    });

    const method = report.functions.find((f) => f.name === "StripeClient.charge");
    expect(method).toMatchObject({ declared: ["net(api.stripe.com)"], actual: ["net(api.stripe.com)"] });
  });
});
