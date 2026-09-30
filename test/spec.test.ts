// PermLang specs (phase 2 groundwork): rules, examples, and permissions for one
// piece of logic in one language-neutral file. Today the permissions are checked
// against the implementation; rules and examples are parsed and reported as not
// yet verified.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { checkSpecs } from "../src/spec/check.js";
import { parseSpecs } from "../src/spec/parse.js";

const dir = fileURLToPath(new URL("./spec-fixtures/", import.meta.url));
const specFile = path.join(dir, "refunds.perm");
const source = readFileSync(specFile, "utf8");

describe("parsing .perm files", () => {
  it("reads each spec's signature, implementation, rules, examples, and permissions", () => {
    const { specs, errors } = parseSpecs(source, specFile);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(2);
    const [refund, notify] = specs;
    expect(refund).toMatchObject({
      name: "process_refund",
      signature: "(order: Order, reason: Text) -> RefundResult",
      line: 3,
      implements: { file: "src/refunds.ts", symbol: "processRefund" },
    });
    expect(refund!.must.map((r) => r.text)).toEqual([
      "refund only orders paid within the last 30 days",
      "never refund more than the amount paid",
      "refunds over $500 require manager approval",
    ]);
    expect(refund!.examples[1]).toMatchObject({ input: "order(paid: $120, 45 days ago)", expected: 'denied("outside 30-day window")' });
    expect(refund!.perms.map((p) => p.name + (p.arg ? `(${p.arg})` : ""))).toEqual(["db.read(orders)", "db.write(refunds)", "email.send"]);
    expect(notify).toMatchObject({ name: "notify_team", must: [], examples: [] });
  });

  it.each([
    ["perm x()\n  perms:\n    net(*)\n", /wildcards/],
    ["perm x()\n  implements: nowhere\n  perms:\n    net\n", /implements.*path#function/],
    ["perm x()\n  wishes:\n    a pony\n", /unknown section "wishes"/],
    ["perm x()\n  examples:\n    no arrow here\n  perms:\n    net\n", /expected "->"/],
    ["perm x()\n  must:\n    be good\n", /no perms: section/],
    ["  perms:\n    net\n", /before any "perm"/],
    ["perm (broken\n", /malformed perm header/],
  ])("reports %j", (text, reason) => {
    const { errors } = parseSpecs(text, "bad.perm");
    expect(errors.map((e) => `${e.line}: ${e.message}`).join("\n")).toMatch(reason);
  });
});

describe("checking specs against code", () => {
  const report = checkFiles([path.join(dir, "src", "refunds.ts"), path.join(dir, "prisma-and-mail.d.ts")], { strictness: "sketch" });
  const { specs } = parseSpecs(source, specFile);
  const results = checkSpecs(specs, report);

  it("passes when the implementation stays within the spec's permissions", () => {
    const refund = results.find((r) => r.spec.name === "process_refund")!;
    expect(refund.diagnostics).toEqual([]);
    expect(refund.status).toBe("perms ok");
  });

  it("fails when the implementation reaches beyond them, and names the access", () => {
    const notify = results.find((r) => r.spec.name === "notify_team")!;
    expect(notify.status).toBe("perms exceeded");
    expect(notify.diagnostics.map((d) => `${d.severity} ${d.code} ${d.capability}`)).toEqual([
      "error SPEC003 net(analytics.example)",
      "warning SPEC004 email.send",
    ]);
  });

  it("never reports rules or examples as verified", () => {
    const refund = results.find((r) => r.spec.name === "process_refund")!;
    expect(refund.must).toEqual({ count: 3, verified: false });
    expect(refund.examples).toEqual({ count: 2, run: false });
  });

  it("reports a spec whose implementation can't be found", () => {
    const { specs: missing } = parseSpecs("perm x()\n  implements: src/refunds.ts#nope\n  perms:\n    net\n", specFile);
    const [result] = checkSpecs(missing, report);
    expect(result!.diagnostics.map((d) => d.code)).toEqual(["SPEC002"]);
  });
});
