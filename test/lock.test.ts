// permlang.lock.json records what every function can reach. It is committed, so
// new access shows up as a change to the lock in the pull request's diff, and
// `permlang check` fails when the code and the lock disagree.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { formatDiffMarkdown, formatDiffText } from "../src/diff.js";
import { buildLock, diffLocks, parseLock, serializeLock, type LockFile } from "../src/lock.js";

const root = fileURLToPath(new URL("./strictness-fixtures/", import.meta.url));
const app = path.join(root, "app.ts");

const current = () => checkFiles([app], { strictness: "sketch" });

describe("lock file", () => {
  it("records each function's reach, keyed by file and name", () => {
    const lock = buildLock(current(), root);
    expect(lock).toEqual({
      permlang: 1,
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
    expect(() => parseLock('{"permlang":2,"functions":{}}', "permlang.lock.json")).toThrow(/version/);
    expect(() => parseLock('{"permlang":1,"functions":{"a#b":"net"}}', "permlang.lock.json")).toThrow(/a#b/);
  });

  it("fails the check when code reaches something the lock doesn't record, even in sketch", () => {
    const stale: LockFile = {
      permlang: 1,
      functions: { "app.ts#annotated": ["net(x.example)"], "app.ts#helper": ["net(helper.example)"], "app.ts#gone": ["exec"] },
      unsafe: {},
    };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: stale } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005").map((d) => `${d.severity} ${d.function} ${d.capability}`);
    expect(drift.sort()).toEqual([
      "error unannotated net(helper.example)",
      "warning gone exec",
    ]);
  });

  it("passes when the lock matches", () => {
    const lock = buildLock(current(), root);
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: lock } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005")).toEqual([]);
  });
});

describe("permlang diff", () => {
  const base: LockFile = {
    permlang: 1,
    functions: { "src/leads.ts#handleLead": ["db.write(lead)", "email.send"], "src/old.ts#legacy": ["exec"] },
    unsafe: {},
  };
  const head: LockFile = {
    permlang: 1,
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

  it("treats a missing base lock as everything new", () => {
    expect(diffLocks(undefined, head).functions.every((f) => f.status === "added")).toBe(true);
  });

  it("formats a pull-request comment with the path to each new access", () => {
    const via = { "src/leads.ts#handleLead": { "net(api.data-broker.io)": ["scoreLead", 'axios.post("https://api.data-broker.io/v2/enrich", ...)'] } };
    const md = formatDiffMarkdown(diffLocks(base, head), via);
    expect(md).toContain("<!-- permlang-diff -->");
    expect(md).toContain("<code>handleLead</code>");
    expect(md).toContain("<code>+ net(api.data-broker.io)</code>");
    expect(md).toContain("scoreLead → axios.post(&quot;https://api.data-broker.io/v2/enrich&quot;, ...)");
    expect(md).toContain("@perm-unsafe");
    expect(md).toMatch(/2 functions gain access/);
  });

  // Found in the second review: capability text went into the comment unescaped, so
  // `fs.read(/a\` | | |\n\n<!--)` could close the cell and open an HTML comment that
  // hides every row after it, along with the approval footer.
  it("escapes text from code, so a crafted capability can't hide rows", () => {
    const evil = "fs.read(/a` | | |\n\n<!--)";
    const sneaky: LockFile = {
      permlang: 1,
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
