// A bug in PermLang must not look like a failed check: exit code 1 means permission errors and
// nothing else. An internal error exits 2, with the error and where it happened, so it can be
// reported (found in the code review, O2). The bug is simulated by making the text report throw.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliStreams } from "./run-cli.js";

vi.mock("../src/report.js", async (original) => ({
  ...(await original<typeof import("../src/report.js")>()),
  formatText: () => {
    throw new TypeError("Cannot read properties of undefined (reading 'x')\n::error::not a real annotation");
  },
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-bug-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("an internal error", () => {
  it("exits 2, with the error, the stack, and where to report it", () => {
    const { code, stdout, stderr } = runCliStreams(["check", "src", "--no-lock"], { cwd: dir });
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^PermLang hit an internal error\. Please report it at https:\/\/github\.com\/PermLang\/PermLang\/issues, with this:\n/);
    // The message is on one line, so it can't start a workflow command of its own.
    expect(stderr).toContain("TypeError: Cannot read properties of undefined (reading 'x')\\n::error::not a real annotation");
    expect(stderr).toMatch(/\n {4}at /);
  });
});
