// Human-readable and JSON output for a check report.

import path from "node:path";
import type { Diagnostic, Report } from "./check.js";

export function formatText(report: Report, cwd = process.cwd()): string {
  const lines = report.diagnostics.map((d) => formatDiagnostic(d, cwd));
  const errors = report.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = report.diagnostics.length - errors;
  const files = plural(report.files, "file");

  if (report.unsafe.length > 0) {
    const entries = report.unsafe.map((u) => `  ${relative(u.file, cwd)}:${u.line} ${u.function}: ${u.reason}`);
    lines.push([`${plural(report.unsafe.length, "@perm-unsafe override")} (checks suppressed):`, ...entries].join("\n"));
  }
  if (report.diagnostics.length === 0) {
    lines.push(`No permission violations in ${files}.`);
  } else {
    lines.push(`${plural(errors, "error")}, ${plural(warnings, "warning")} in ${files}.`);
  }
  return lines.join("\n\n");
}

function formatDiagnostic(d: Diagnostic, cwd: string): string {
  const location = `${relative(d.file, cwd)}:${d.line}:${d.column}`;
  const [first, ...rest] = d.message.split("\n");
  const out = [`${location} ${d.severity} ${d.code}: ${first}`, ...rest.map((l) => `  ${l.trim()}`)];
  if (d.fix) out.push(`  -> ${d.fix}`);
  return out.join("\n");
}

export function toJson(report: Report, cwd = process.cwd()): string {
  return JSON.stringify(
    {
      version: 1,
      files: report.files,
      functions: report.functions.map((f) => ({ ...f, file: relative(f.file, cwd) })),
      diagnostics: report.diagnostics.map((d) => ({ ...d, file: relative(d.file, cwd) })),
      unsafe: report.unsafe.map((u) => ({ ...u, file: relative(u.file, cwd) })),
    },
    null,
    2,
  );
}

function relative(file: string, cwd: string): string {
  return path.relative(cwd, file).replaceAll("\\", "/");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
