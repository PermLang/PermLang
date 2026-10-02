// Human-readable and JSON output for a check report.

import path from "node:path";
import type { Diagnostic, Report } from "./check.js";

export function formatText(report: Report, cwd = process.cwd()): string {
  const lines = report.diagnostics.map((d) => formatDiagnostic(d, cwd));
  const errors = report.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = report.diagnostics.length - errors;
  const files = plural(report.files, "file");

  if (report.unresolved.length > 0) {
    lines.push(`${plural(report.unresolved.length, "import")} with no types, unchecked: ${report.unresolved.join(", ")}.`);
  }
  if (report.unmapped.length > 0) {
    const shown = report.unmapped.slice(0, 10).map((u) => `${u.package} (${u.calls})`).join(", ");
    const more = report.unmapped.length > 10 ? `, and ${report.unmapped.length - 10} more (see --json)` : "";
    lines.push(`${plural(report.unmapped.length, "package")} with no adapter, trusted (calls): ${shown}${more}.`);
  }
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
      unmapped: report.unmapped.map((u) => ({ ...u, file: relative(u.file, cwd) })),
      unresolved: report.unresolved,
    },
    null,
    2,
  );
}

/**
 * GitHub Actions workflow commands, one per diagnostic, so each shows on its line in a pull
 * request. `root` is the repository root (GITHUB_WORKSPACE), which annotation paths are relative to.
 * Errors come first: GitHub shows only the first few annotations of each kind per step.
 */
export function formatAnnotations(report: Report, root: string): string {
  const ordered = [...report.diagnostics].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error"));
  return ordered
    .map((d) => {
      const message = d.message.split("\n").map((l) => l.trim()).join("\n") + (d.fix ? `\n-> ${d.fix}` : "");
      const title = `PermLang ${d.code}${d.capability ? `: ${d.capability}` : ""}`;
      const properties = [`file=${property(relative(d.file, root))}`, `line=${d.line}`, `col=${d.column}`, `title=${property(title)}`];
      return `::${d.severity === "error" ? "error" : "warning"} ${properties.join(",")}::${data(message)}`;
    })
    .join("\n");
}

// GitHub's escaping for workflow commands: the message can't contain a raw newline, which would
// let code text start a command of its own; properties also can't contain `:` or `,`.
function data(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function property(text: string): string {
  return data(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function relative(file: string, cwd: string): string {
  return path.relative(cwd, file).replaceAll("\\", "/");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
