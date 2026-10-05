// permlang.lock.json records what every function can reach. It is committed, so
// new access shows up as a change to the lock in the pull request's diff, and
// `permlang check` fails when the code and the lock disagree.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type Report } from "../src/check.js";
import { commentMarker, formatDiffMarkdown, formatDiffText } from "../src/diff.js";
import { buildLock, diffLocks, isConfigKey, lockDrift, parseLock, serializeLock, splitKey, type LockFile } from "../src/lock.js";

const root = fileURLToPath(new URL("./strictness-fixtures/", import.meta.url));
const app = path.join(root, "app.ts");

const current = () => checkFiles([app], { strictness: "sketch" });
const lockDriftOf = (committed: LockFile, report: Report, text: string) => lockDrift(committed, buildLock(report, root), report, path.join(root, "permlang.lock.json"), text);

describe("lock file", () => {
  it("records each function's reach, keyed by file and name", () => {
    const lock = buildLock(current(), root);
    expect(lock).toEqual({
      permlang: 2,
      functions: {
        "app.ts#annotated": ["net(x.example)"],
        "app.ts#helper": ["net(helper.example)"],
        "app.ts#unannotated": ["net(helper.example)"],
      },
      unsafe: {},
    });
  });

  it("serializes stably, sorted, with a trailing newline", () => {
    const text = serializeLock(buildLock(current(), root));
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseLock(text, "permlang.lock.json")).toEqual(buildLock(current(), root));
    expect(serializeLock(parseLock(text, "x"))).toBe(text);
  });

  it("rejects a malformed lock file", () => {
    expect(() => parseLock("{", "permlang.lock.json")).toThrow(/permlang.lock.json/);
    expect(() => parseLock('{"permlang":3,"functions":{}}', "permlang.lock.json")).toThrow(/version 3 isn't one this PermLang reads/);
    expect(() => parseLock('{"permlang":2,"functions":[["net"]]}', "permlang.lock.json")).toThrow(/"functions" must be an object/);
    expect(() => parseLock('{"permlang":1,"functions":{"a#b":"net"}}', "permlang.lock.json")).toThrow(/a#b/);
  });

  // Access the lock records but the code doesn't reach used to be a warning, so a pull request
  // could approve access in advance by editing only the lock (found in the code review, G1).
  it("fails the check when the code and the lock differ either way, even in sketch", () => {
    const stale: LockFile = {
      permlang: 2,
      functions: { "app.ts#annotated": ["net(x.example)"], "app.ts#helper": ["net(helper.example)"], "app.ts#gone": ["exec"] },
      unsafe: {},
    };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: stale } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005").map((d) => `${d.severity} ${d.function} ${d.capability}`);
    expect(drift.sort()).toEqual(["error gone exec", "error unannotated net(helper.example)"]);
    // New access points at the line that reaches it (`return helper();`), not the function's first
    // line, so a pull-request annotation lands on the change.
    const added = report.diagnostics.find((d) => d.code === "PERM005" && d.capability === "net(helper.example)")!;
    expect(`${added.line}:${added.column}`).toBe("8:10");
  });

  it("points at the lock's own line for access only the lock has", () => {
    const lock = buildLock(current(), root);
    lock.functions["app.ts#helper"]!.push("exec");
    const text = serializeLock(lock);
    const report = checkFiles([app], { strictness: "sketch" });
    const [drift] = lockDriftOf(lock, report, text);
    expect(drift).toMatchObject({ severity: "error", file: path.join(root, "permlang.lock.json"), line: text.split("\n").findIndex((l) => l.includes('"exec"')) + 1 });
    expect(drift!.message).toBe("helper no longer reaches exec, but permlang.lock.json still records it.");
  });

  it("fails on a lock written by an older PermLang, with one error", () => {
    const old = { ...buildLock(current(), root), permlang: 1 as const };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: old } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005").map((d) => d.message)).toEqual([
      "permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.",
    ]);
  });

  // With two functions named helper, the second one's override replaced the first one's reviewed
  // reason under a single key, so the comment showed nothing new (found in the code review, G9).
  it("keys @perm-unsafe overrides like functions, so same-named functions keep their own", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "permlang-lock-"));
    try {
      const file = path.join(dir, "u.ts");
      writeFileSync(file, '/** @perm-unsafe reason:"first" */\nfunction helper() { return 1; }\n/** @perm-unsafe reason:"second" */\nfunction helper2() { return 2; }\nnamespace N {\n  /** @perm-unsafe reason:"third" */\n  export function helper() { return 3; }\n}\nexport { helper, helper2, N };\n');
      const again = buildLock(checkFiles([file]), dir);
      expect(again.unsafe).toEqual({ "u.ts#helper": "first", "u.ts#helper#2": "third", "u.ts#helper2": "second" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A `#` in a file name made the key ambiguous (found in the code review, O5).
  it("keeps a file name with # or % apart from the function name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "permlang-lock-"));
    try {
      const file = path.join(dir, "we#ird%20.ts");
      writeFileSync(file, 'export function go() { return fetch("https://x.example/"); }\n');
      const lock = buildLock(checkFiles([file]), dir);
      expect(Object.keys(lock.functions)).toEqual(["we%23ird%2520.ts#go"]);
      expect(splitKey("we%23ird%2520.ts#go")).toEqual(["we#ird%20.ts", "go"]);
      expect(splitKey("src/a.ts#Class.#secret#2")).toEqual(["src/a.ts", "Class.#secret"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the lock matches", () => {
    const lock = buildLock(current(), root);
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: lock } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005")).toEqual([]);
  });
});

describe("permlang diff", () => {
  const base: LockFile = {
    permlang: 2,
    functions: { "src/leads.ts#handleLead": ["db.write(lead)", "email.send"], "src/old.ts#legacy": ["exec"] },
    unsafe: {},
  };
  const head: LockFile = {
    permlang: 2,
    functions: {
      "src/leads.ts#handleLead": ["db.write(lead)", "email.send", "env(BROKER_API_KEY)", "net(api.data-broker.io)"],
      "src/scoring.ts#scoreLead": ["env(BROKER_API_KEY)", "net(api.data-broker.io)"],
    },
    unsafe: { "src/render.ts#compile": "template compiler" },
  };

  it("lists what each function gains and loses", () => {
    const diff = diffLocks(base, head);
    expect(diff.functions).toEqual([
      { key: "src/leads.ts#handleLead", file: "src/leads.ts", name: "handleLead", status: "changed", added: ["env(BROKER_API_KEY)", "net(api.data-broker.io)"], removed: [] },
      { key: "src/old.ts#legacy", file: "src/old.ts", name: "legacy", status: "removed", added: [], removed: ["exec"] },
      { key: "src/scoring.ts#scoreLead", file: "src/scoring.ts", name: "scoreLead", status: "added", added: ["env(BROKER_API_KEY)", "net(api.data-broker.io)"], removed: [] },
    ]);
    expect(diff.unsafeAdded).toEqual([{ key: "src/render.ts#compile", reason: "template compiler" }]);
  });

  it("tells configuration entries from functions, whatever the file name's case or JSON flavor", () => {
    for (const key of [
      ".github/workflows/ci.yml#<ci.yml>",
      ".github/workflows/CI.YML#<CI.YML>",
      ".github/workflows/deploy.yaml#<deploy.yaml>",
      "packages/a/package.json5#<package.json5>",
      "package.json#<package.json>",
      "permlang.config.json#<permlang.config.json>",
      "tsconfig.json#<tsconfig.json>",
      "config/tsconfig.build.JSON#<tsconfig.build.JSON>",
    ]) {
      expect(isConfigKey(key), key).toBe(true);
    }
    for (const key of ["src/a.ts#<module>", "src/a.ts#<anonymous>", "src/a.ts#handler", "src/json.ts#parse.json"]) expect(isConfigKey(key), key).toBe(false);
  });

  it("treats a missing base lock as everything new", () => {
    expect(diffLocks(undefined, head).functions.every((f) => f.status === "added")).toBe(true);
  });

  it("formats a pull-request comment with the path to each new access", () => {
    const via = { "src/leads.ts#handleLead": { "net(api.data-broker.io)": ["scoreLead", 'axios.post("https://api.data-broker.io/v2/enrich", ...)'] } };
    const md = formatDiffMarkdown(diffLocks(base, head), via);
    expect(md).toContain("<!-- permlang-diff -->");
    expect(md).toContain("<code>handleLead</code>");
    expect(md).toContain("<code>+ net(api.data-broker.io)</code>");
    // A zero-width space after "https:" keeps GitHub from making a link of text from the code.
    expect(md).toContain("scoreLead → axios.post(&quot;https:\u{200b}//api.data-broker.io/v2/enrich&quot;, ...)");
    expect(md).toContain("<code>@perm-unsafe</code>");
    expect(md).toMatch(/2 functions gain access/);
  });

  // One logger with 1,750 callers made one table cell longer than GitHub allows a comment (G6).
  it("names at most 20 functions that can now reach a capability, and counts the rest", () => {
    const callers: LockFile = { permlang: 2, functions: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`src/f.ts#caller${i}`, ["net(log.example)"]])), unsafe: {} };
    const row = formatDiffMarkdown(diffLocks(undefined, callers), {}).split("\n").find((l) => l.startsWith("| <code>+ net(log.example)"))!;
    expect(row.match(/<code>caller\d+<\/code>/g)).toHaveLength(20);
    expect(row).toContain(", and 30 more |");
  });

  it("shows a changed @perm-unsafe reason, with the old one", () => {
    const changed: LockFile = { ...head, unsafe: { "src/render.ts#compile": "anything goes" } };
    const diff = diffLocks(head, changed);
    expect(diff.unsafeChanged).toEqual([{ key: "src/render.ts#compile", before: "template compiler", after: "anything goes" }]);
    expect(formatDiffMarkdown(diff, {})).toContain("- <code>src/render.ts#compile</code>: anything goes <sub>(was: template compiler)</sub>");
    expect(formatDiffMarkdown(diff, {})).toContain("**1 changed <code>@perm-unsafe</code> reason**");
    expect(formatDiffText(diff, {})).toBe("src/render.ts#compile\n  ~ @perm-unsafe: anything goes (was: template compiler)");
  });

  // Several Action runs on one pull request, one per package, replaced each other's comment
  // (found in the code review, G12).
  it("marks the comment with the folder it's for, when that isn't the repository root", () => {
    expect(commentMarker("")).toBe("<!-- permlang-diff -->");
    expect(commentMarker(".")).toBe("<!-- permlang-diff -->");
    expect(commentMarker("packages/api")).toBe("<!-- permlang-diff: packages/api -->");
    expect(commentMarker("packages\\my-app\\")).toBe("<!-- permlang-diff: packages/my%2Dapp -->");
    expect(commentMarker("a --> b")).toBe("<!-- permlang-diff: a%20%2D%2D%3E%20b -->");
    expect(formatDiffMarkdown(diffLocks(head, head), {}, { marker: commentMarker("packages/api") }).split("\n")[0]).toBe("<!-- permlang-diff: packages/api -->");
  });

  // Found in the second review: capability text went into the comment unescaped, so
  // `fs.read(/a\` | | |\n\n<!--)` could close the cell and open an HTML comment that
  // hides every row after it, along with the approval footer.
  it("escapes text from code, so a crafted capability can't hide rows", () => {
    const evil = "fs.read(/a` | | |\n\n<!--)";
    const sneaky: LockFile = {
      permlang: 2,
      functions: { "src/a.ts#f": [evil, "fs.read(/root/.ssh/id_rsa)"], "src/b.ts#g`|<x>": ["net"] },
      unsafe: { "src/c.ts#h": "reason with `backticks` | pipes <!-- and a comment" },
    };
    const md = formatDiffMarkdown(diffLocks(undefined, sneaky), { "src/a.ts#f": { [evil]: ["<!-- x", "a|b"] } });
    // Everything except PermLang's own marker and footer comes from code.
    const body = md.replace("<!-- permlang-diff -->", "").split("\n").filter((l) => !l.startsWith("<sub>Approving")).join("\n");
    expect(body).not.toContain("<!--");
    expect(body).not.toMatch(/`/);
    expect(md).toContain("fs.read(/root/.ssh/id&#95;rsa)"); // GitHub renders the entity as id_rsa
    expect(md).toContain("Approving this change approves the access above");
    // One table row per capability: the crafted one didn't break the table.
    const rows = md.split("\n").filter((l) => l.startsWith("| <code>+ "));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.split(/(?<!\\)\|/).length).toBe(5);
  });

  it("says so when nothing changed", () => {
    expect(formatDiffMarkdown(diffLocks(head, head), {})).toContain("No permission changes");
    expect(formatDiffText(diffLocks(head, head), {})).toBe("No permission changes.");
  });
});
