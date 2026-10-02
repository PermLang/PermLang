// GitHub annotations: `permlang check --annotations` adds a workflow command per
// diagnostic, so each one shows on its line in a pull request's "Files changed" tab.

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic, Report } from "../src/check.js";
import { formatAnnotations } from "../src/report.js";

const root = path.resolve("/repo");
const diagnostic = (d: Partial<Diagnostic>): Diagnostic => ({
  severity: "error",
  code: "PERM001",
  file: path.join(root, "src", "leads.ts"),
  line: 9,
  column: 9,
  function: "handleLead",
  capability: "net(data-broker.io)",
  call: "fetch(...)",
  message: "handleLead calls fetch(\"https://data-broker.io/enrich\")\n  but its declared permissions do not include net(data-broker.io).",
  fix: "add net(data-broker.io) to @perm, or remove the call.",
  ...d,
});
const report = (diagnostics: Diagnostic[]): Report => ({ files: 1, functions: [], units: [], diagnostics, unsafe: [], unmapped: [], unresolved: [] }) as unknown as Report;

describe("GitHub annotations", () => {
  it("writes one workflow command per diagnostic, on its file and line, relative to the repository", () => {
    expect(formatAnnotations(report([diagnostic({})]), root)).toBe(
      "::error file=src/leads.ts,line=9,col=9,title=PermLang PERM001%3A net(data-broker.io)::" +
        "handleLead calls fetch(\"https://data-broker.io/enrich\")%0Abut its declared permissions do not include net(data-broker.io).%0A-> add net(data-broker.io) to @perm, or remove the call.",
    );
  });

  it("lists errors before warnings, since GitHub shows only the first few of each", () => {
    const out = formatAnnotations(report([diagnostic({ severity: "warning", code: "PERM006" }), diagnostic({ code: "PERM005" })]), root).split("\n");
    expect(out.map((l) => l.slice(0, l.indexOf(" ")))).toEqual(["::error", "::warning"]);
  });

  it("escapes code text, so a message can't start a workflow command of its own", () => {
    const hostile = diagnostic({ message: "calls x()\n::add-mask::secret\r::error::fake", capability: "net(a,b:c)" });
    const out = formatAnnotations(report([hostile]), root);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("calls x()%0A::add-mask::secret%0D::error::fake");
    expect(out).toContain("title=PermLang PERM001%3A net(a%2Cb%3Ac)");
    // A literal "%0A" in code text stays text, not a line break.
    expect(formatAnnotations(report([diagnostic({ message: "calls fetch(\"/a%0Ab\")", fix: "" })]), root)).toContain("::calls fetch(\"/a%250Ab\")");
  });

  it("writes nothing when there are no diagnostics", () => {
    expect(formatAnnotations(report([]), root)).toBe("");
  });
});
