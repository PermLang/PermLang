// The text report prints values that come from the analyzed code: capabilities built from string
// literals, tool names, @perm-unsafe reasons, package names. In GitHub Actions, the runner reads
// every line of a step's output and obeys the ones that start with `::` (workflow commands), so a
// value with a line break in it could silence PermLang's annotations or add fake ones. A terminal
// obeys escape sequences the same way. Found in the code review (O1, O5).

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic, Report } from "../src/check.js";
import { formatText, printable } from "../src/report.js";

const root = path.resolve("/repo");
const report = (r: Partial<Report>): Report => ({ files: 1, functions: [], units: [], diagnostics: [], unsafe: [], unmapped: [], unresolved: [], tools: [], ...r });
const evil = "A\n::stop-commands::x\r\n::error::fake\x1b[31mred\u{2028}\x9b2J";

/** True when some line of the output, after leading spaces, starts a workflow command. */
const startsCommand = (out: string) => out.split(/\r\n|\r|\n|\u{2028}|\u{2029}|\x85/u).some((l) => l.trimStart().startsWith("::"));

describe("printable", () => {
  it("turns line breaks and control characters into visible escapes", () => {
    expect(printable("a\nb\rc\td")).toBe("a\\nb\\rc\\td");
    expect(printable("\x1b[31mred\x1b[0m")).toBe("\\u001b[31mred\\u001b[0m");
    expect(printable("\x9b2J \x85 \u{2028} \u{202e}")).toBe("\\u009b2J \\u0085 \\u2028 \\u202e");
  });

  it("leaves ordinary text alone", () => {
    const ordinary = 'fetch("https://api.example.com/x?y=1") → ünïcode, \\ and "quotes"';
    expect(printable(ordinary)).toBe(ordinary);
  });
});

describe("the text report", () => {
  const diagnostic = (d: Partial<Diagnostic>): Diagnostic => ({
    severity: "error",
    code: "PERM003",
    file: path.join(root, "src", "a.ts"),
    line: 3,
    column: 5,
    function: "ping",
    capability: `env(${evil})`,
    call: "process.env[...]",
    message: `ping reads process.env[...] but has no @perm annotation.`,
    fix: `add /** @perm env(${evil}) */ to ping.`,
    ...d,
  });

  it("can't be made to print a line of its own by a value from the code", () => {
    const out = formatText(
      report({
        diagnostics: [
          diagnostic({}),
          // PermLang's own messages break once, before "but"; a break inside a value is escaped.
          diagnostic({ code: "PERM001", message: `ping reads process.env[...]\n  but its declared permissions do not include env(${evil}).` }),
        ],
        unresolved: [evil],
        unmapped: [{ package: evil, calls: 1, file: path.join(root, "src", "a.ts"), line: 1 }],
        tools: [{ name: evil, framework: "ai", file: path.join(root, "src", "a.ts"), line: 1, function: "f", reaches: [`net(${evil})`] }],
        unsafe: [{ file: path.join(root, "src", "a.ts"), line: 1, function: "f", reason: evil }],
      }),
      root,
    );
    expect(startsCommand(out)).toBe(false);
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u{2028}\u{2029}]/u);
    expect(out).toContain("A\\n::stop-commands::x\\r\\n::error::fake\\u001b[31mred\\u2028\\u009b2J");
  });

  it("keeps PermLang's own line break before the reason", () => {
    const message = "ping calls fetch(...)\n  but its declared permissions do not include net(x.example).";
    const out = formatText(report({ diagnostics: [diagnostic({ code: "PERM001", capability: "net(x.example)", message, fix: "add net(x.example) to @perm, or remove the call." })] }), root);
    expect(out.split("\n").slice(0, 3)).toEqual([
      "src/a.ts:3:5 error PERM001: ping calls fetch(...)",
      "  but its declared permissions do not include net(x.example).",
      "  -> add net(x.example) to @perm, or remove the call.",
    ]);
  });
});
