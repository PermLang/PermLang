// Checks specs against the code that implements them. Phase 2 groundwork:
//   - perms:    verified. The implementation's actual reach must stay within them
//               (SPEC003), and unused permissions are reported (SPEC004).
//   - must:     parsed and counted, not verified yet.
//   - examples: parsed and counted, not run yet.
// Nothing reports rules or examples as passing until they are really checked.

import path from "node:path";
import { covers, formatCapability, type Capability } from "../capability.js";
import type { Diagnostic, FunctionReport, Report } from "../check.js";
import type { Spec } from "./parse.js";

export interface SpecResult {
  spec: Spec;
  implementation?: FunctionReport | { file: string; name: string; actual: []; via: Record<string, string[]> };
  status: "perms ok" | "perms exceeded" | "not found";
  diagnostics: Diagnostic[];
  must: { count: number; verified: false };
  examples: { count: number; run: false };
}

export function checkSpecs(specs: readonly Spec[], report: Report): SpecResult[] {
  return specs.map((spec) => {
    const base = { spec, must: { count: spec.must.length, verified: false as const }, examples: { count: spec.examples.length, run: false as const } };
    const at = (line: number) => ({ file: spec.file, line, column: 1, function: spec.name, call: "" });

    if (!spec.implements) {
      return { ...base, status: "not found" as const, diagnostics: [{ ...at(spec.line), severity: "error" as const, code: "SPEC002" as const, capability: "", message: `perm ${spec.name} has no implements: line, so it can't be checked.`, fix: "add implements: path/to/file.ts#functionName." }] };
    }
    const target = normalize(path.resolve(path.dirname(spec.file), spec.implements.file));
    const unit = report.units.find((u) => normalize(u.file) === target && u.name === spec.implements!.symbol);
    if (!unit) {
      return { ...base, status: "not found" as const, diagnostics: [{ ...at(spec.implements.line), severity: "error" as const, code: "SPEC002" as const, capability: `${spec.implements.file}#${spec.implements.symbol}`, message: `perm ${spec.name}: ${spec.implements.file}#${spec.implements.symbol} wasn't found among the checked files.`, fix: "check the path and function name, and that the file is part of the checked sources." }] };
    }
    const fn = report.functions.find((f) => normalize(f.file) === target && f.name === unit.name) ?? { file: unit.file, name: unit.name, actual: [] as [], via: {} as Record<string, string[]> };

    const actual = fn.actual.map(parseCapability);
    const diagnostics: Diagnostic[] = [];
    for (const [i, capability] of actual.entries()) {
      if (covers(spec.perms, capability)) continue;
      const key = fn.actual[i]!;
      const via = fn.via[key];
      diagnostics.push({
        ...at(spec.implements.line),
        severity: "error",
        code: "SPEC003",
        capability: key,
        message: `${unit.name} reaches ${key}${via ? `, via ${via.join(" → ")}` : ""}, which perm ${spec.name} doesn't allow.`,
        fix: `add ${key} to the spec's perms:, or remove the access.`,
      });
    }
    for (const permission of spec.perms) {
      if (actual.some((a) => covers([permission], a))) continue;
      diagnostics.push({
        ...at(spec.line),
        severity: "warning",
        code: "SPEC004",
        capability: formatCapability(permission),
        message: `perm ${spec.name} allows ${formatCapability(permission)}, but ${unit.name} never uses it.`,
        fix: "remove it from perms: to keep the spec's permissions minimal.",
      });
    }
    const exceeded = diagnostics.some((d) => d.severity === "error");
    return { ...base, implementation: fn, status: exceeded ? "perms exceeded" : "perms ok", diagnostics };
  });
}

/** "net(api.stripe.com)" → { name: "net", arg: "api.stripe.com" }; a bare name has no arg. */
function parseCapability(text: string): Capability {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(text);
  return m && m[2] !== undefined ? { name: m[1]!, arg: m[2] } : { name: text };
}

// Windows and macOS file systems ignore case by default; Linux's don't, where
// src/Refunds.ts and src/refunds.ts are different files.
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normalize(file: string): string {
  const resolved = path.resolve(file).replaceAll("\\", "/");
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** The report text for `permlang spec`, in the shape of the concept overview's example. */
export function formatSpecResults(results: readonly SpecResult[], cwd = process.cwd()): string {
  const blocks = results.map((r) => {
    const impl = r.spec.implements ? `${r.spec.implements.file}#${r.spec.implements.symbol}` : "(no implements:)";
    const perms =
      r.status === "not found"
        ? "implementation not found"
        : r.status === "perms exceeded"
          ? `FAIL: reaches ${r.diagnostics.filter((d) => d.code === "SPEC003").map((d) => d.capability).join(", ")}`
          : "no access beyond the declared scope";
    const lines = [
      `perm ${r.spec.name}  ${impl}`,
      `  perms     ${perms}`,
      `  must      ${r.must.count} rule${r.must.count === 1 ? "" : "s"}, not verified yet (phase 2)`,
      `  examples  ${r.examples.count} example${r.examples.count === 1 ? "" : "s"}, not run yet (phase 2)`,
    ];
    for (const d of r.diagnostics) {
      lines.push(`  ${path.relative(cwd, d.file).replaceAll("\\", "/")}:${d.line} ${d.severity} ${d.code}: ${d.message}`);
    }
    return lines.join("\n");
  });
  const failed = results.filter((r) => r.status !== "perms ok").length;
  blocks.push(results.length === 0 ? "No .perm specs found." : `${results.length} spec${results.length === 1 ? "" : "s"}, ${failed} failing.`);
  return blocks.join("\n\n");
}
