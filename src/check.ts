// Compares each function's declared permissions with everything it can reach.
//
// A unit's actual permissions are its direct uses plus everything its callees
// reach, across files. Declared permissions are the unit's own @perm tags plus
// its file's @module @perm tags.

import path from "node:path";
import { Project, ts, type Node } from "ts-morph";
import { AdapterError, AdapterIndex, loadAdapters } from "./adapters.js";
import { UNVERIFIABLE, covers, formatCapability } from "./capability.js";
import { detectInFile } from "./detect/index.js";
import { Hierarchy } from "./dispatch.js";
import { buildLock, lockDrift, type LockFile } from "./lock.js";
import { collectEdges, pathTo, propagate, type Edge, type Reach } from "./graph.js";
import {
  createUnit,
  declaredCapabilities,
  enclosingUnitNode,
  exportedDeclarations,
  isAnnotated,
  isInNodeModules,
  isUnitNode,
  readModuleAnnotation,
  type Unit,
  type Use,
} from "./units.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /**
   * PERM001 undeclared capability, PERM002 invalid annotation, PERM003 missing
   * annotation, PERM004 unverifiable code (eval, computed calls on sensitive objects, ...),
   * PERM005 permissions that differ from permlang.lock.json.
   */
  code: "PERM001" | "PERM002" | "PERM003" | "PERM004" | "PERM005";
  file: string;
  line: number;
  column: number;
  function: string;
  /** The capability involved, formatted; for PERM002, the entry as written. */
  capability: string;
  /** The offending call as written; empty for annotation errors. */
  call: string;
  /** For capabilities reached through helpers: each unit on the way, then the call that uses it. */
  path?: string[];
  message: string;
  fix?: string;
}

export interface FunctionReport {
  file: string;
  name: string;
  line: number;
  annotated: boolean;
  declared: string[];
  actual: string[];
  /** For each actual capability: the units on the way to it, then the call that uses it. */
  via: Record<string, string[]>;
}

/** A function whose checks are suppressed by @perm-unsafe. Always reported. */
export interface UnsafeReport {
  file: string;
  line: number;
  function: string;
  reason: string;
}

export interface Report {
  files: number;
  functions: FunctionReport[];
  diagnostics: Diagnostic[];
  unsafe: UnsafeReport[];
}

/**
 * How strictly annotations are enforced (design doc §7). An out-of-date lock
 * file fails at every level: it is the review gate, not an annotation rule.
 *   sketch       permissions are inferred and reported; nothing else fails
 *   development  exported functions and entry points must declare what they reach (default)
 *   production   every function must be covered by function- or module-level @perm
 */
export type Strictness = "sketch" | "development" | "production";

export const STRICTNESS_LEVELS: readonly Strictness[] = ["sketch", "development", "production"];

export interface CheckOptions {
  /** Team adapter manifests, loaded before (and taking precedence over) the built-in ones. */
  adapters?: readonly string[];
  strictness?: Strictness;
  /** The committed lock file to compare against; keys are relative to its directory. */
  lock?: { file: string; contents: LockFile };
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  allowJs: false,
  noEmit: true,
  skipLibCheck: true,
};

// These read source files through ts-morph too. ts-morph has no adapter, so that
// read isn't detected (design doc decision D1); fs.read covers it anyway.

/** @perm fs.read */
export function checkFiles(files: readonly string[], options: CheckOptions = {}): Report {
  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  project.addSourceFilesAtPaths([...files]);
  return checkProject(project, options);
}

/** @perm fs.read */
export function checkTsConfig(tsConfigFilePath: string, options: CheckOptions = {}): Report {
  return checkProject(new Project({ tsConfigFilePath }), options);
}

/**
 * @throws AdapterError when an adapter manifest is invalid.
 * @perm fs.read
 */
export function checkProject(project: Project, options: CheckOptions = {}): Report {
  const loaded = loadAdapters(options.adapters ?? []);
  if (loaded.errors.length > 0) throw new AdapterError(loaded.errors);
  const adapters = new AdapterIndex(loaded.adapters);
  const strictness = options.strictness ?? "development";

  const sourceFiles = project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !isInNodeModules(sf));
  const units = new Map<Node, Unit>();
  const diagnostics: Diagnostic[] = [];

  // 1. Every unit in every file, with its annotations and direct uses.
  for (const sourceFile of sourceFiles) {
    const module = readModuleAnnotation(sourceFile, adapters.vocabulary);
    const exports = exportedDeclarations(sourceFile);
    const add = (node: Node) => units.set(node, createUnit(node, module, exports, adapters.vocabulary));

    add(sourceFile);
    sourceFile.forEachDescendant((node) => {
      if (isUnitNode(node)) add(node);
    });
    for (const e of module?.errors ?? []) diagnostics.push(annotationError(sourceFile.getFilePath(), "<module>", e));

    for (const { node, uses } of detectInFile(sourceFile, adapters)) {
      const unit = units.get(enclosingUnitNode(node))!;
      const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
      for (const u of uses) unit.uses.push({ ...u, line, column });
    }
  }

  // 2. Edges between units, then what each unit can reach.
  const context = { unitOf: (node: Node) => units.get(node), hierarchy: new Hierarchy(sourceFiles), adapters };
  const edges = sourceFiles.flatMap((sf) => collectEdges(sf, context));
  const reach = propagate(units.values(), edges);
  const edgesFrom = groupBy(edges, (e) => e.from);

  // 3. Compare declared with actual.
  const functions: FunctionReport[] = [];
  for (const unit of units.values()) {
    const reached = reach.get(unit)!;
    if (!isAnnotated(unit) && reached.size === 0) continue;
    functions.push(summarize(unit, reach));
    diagnostics.push(...diagnose(unit, edgesFrom.get(unit) ?? [], reach, strictness));
  }

  const unsafe = [...units.values()].flatMap((u) =>
    u.own?.unsafe ? [{ file: u.file, line: u.own.unsafe.line, function: u.name, reason: u.own.unsafe.reason }] : [],
  );
  unsafe.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Sketch reports everything but fails nothing.
  const checked = strictness === "sketch" ? diagnostics.map((d) => ({ ...d, severity: "warning" as const })) : diagnostics;
  const report: Report = { files: sourceFiles.length, functions, diagnostics: checked, unsafe };
  if (options.lock) {
    const root = path.dirname(options.lock.file);
    report.diagnostics.push(...lockDrift(options.lock.contents, buildLock(report, root), report, options.lock.file));
  }
  report.diagnostics = dedupe(report.diagnostics);
  return report;
}

// --- diagnostics -------------------------------------------------------------

function summarize(unit: Unit, reach: Reach): FunctionReport {
  const via = Object.fromEntries([...reach.get(unit)!.keys()].map((key) => [key, pathTo(reach, unit, key)]));
  return {
    file: unit.file,
    name: unit.name,
    line: unit.line,
    annotated: isAnnotated(unit),
    declared: [...new Set(declaredCapabilities(unit).map(formatCapability))],
    actual: [...reach.get(unit)!.keys()],
    via,
  };
}

function diagnose(unit: Unit, edges: readonly Edge[], reach: Reach, strictness: Strictness): Diagnostic[] {
  const out: Diagnostic[] = (unit.own?.errors ?? []).map((e) => annotationError(unit.file, unit.name, e));

  if (!isAnnotated(unit)) {
    // development: exported functions and top-level code must declare; production: everything.
    if (unit.exported || strictness === "production") out.push(...missingAnnotation(unit, reach));
    return out;
  }
  // @perm-unsafe suppresses this unit's own checks. Its callers still see what it reaches.
  if (unit.own?.unsafe) return out;

  const declared = declaredCapabilities(unit);
  for (const use of unit.uses) {
    if (covers(declared, use.capability)) continue;
    out.push(violation(unit, use, use.verb, formatCapability(use.capability), [], use.capability.dynamic === true));
  }
  for (const edge of edges) {
    if (edge.to === unit) continue; // recursion into itself adds nothing new
    for (const [key, p] of reach.get(edge.to)!) {
      if (covers(declared, p.capability)) continue;
      if (key === UNVERIFIABLE && edge.to.own?.unsafe) continue; // vouched for by @perm-unsafe
      const path = [edge.to.name, ...pathTo(reach, edge.to, key)];
      out.push(violation(unit, edge, "calls", key, path, p.capability.dynamic === true));
    }
  }
  return out;
}

/** What a capability's argument names, for "its ___ can't be determined statically". */
function scopeWord(capability: string): string {
  if (capability === "net") return "host";
  if (capability.startsWith("fs.")) return "path";
  if (capability.startsWith("db.")) return "table";
  if (capability === "env") return "variable name";
  return "argument";
}

function violation(
  unit: Unit,
  site: Use | Edge,
  verb: string,
  capability: string,
  path: string[],
  dynamic: boolean,
): Diagnostic {
  const via = path.length > 0 ? `, reaching ${path.join(" → ")}` : "";
  if (capability === UNVERIFIABLE) return unverifiable(unit, site, verb, path, "error");
  const reason = dynamic
    ? `its ${scopeWord(capability)} can't be determined statically, so it needs ${capability}`
    : `its declared permissions do not include ${capability}`;
  return {
    severity: "error",
    code: "PERM001",
    file: unit.file,
    line: site.line,
    column: site.column,
    function: unit.name,
    capability,
    call: site.call,
    ...(path.length > 0 ? { path } : {}),
    message: `${unit.name} ${verb} ${site.call}${via}\n  but ${reason}.`,
    fix: `add ${capability} to @perm, or remove the call.`,
  };
}

/** Code whose effects can't be known. Only @perm-unsafe accepts it. */
function unverifiable(unit: Unit, site: Use | Edge, verb: string, path: string[], severity: Severity): Diagnostic {
  const via = path.length > 0 ? `, reaching ${path.join(" → ")}` : "";
  return {
    severity,
    code: "PERM004",
    file: unit.file,
    line: site.line,
    column: site.column,
    function: unit.name,
    capability: UNVERIFIABLE,
    call: site.call,
    ...(path.length > 0 ? { path } : {}),
    message: `${unit.name} ${verb} ${site.call}${via}
  which can't be verified statically.`,
    fix: `rewrite it so what it calls is known statically, or mark ${path.length > 0 ? "the function that does it" : unit.name} @perm-unsafe with a reason.`,
  };
}

/** One error per capability an unannotated unit reaches, at the first place it does. */
function missingAnnotation(unit: Unit, reach: Reach): Diagnostic[] {
  return [...reach.get(unit)!].map(([key, p]) => {
    const site = p.edge ?? p.use;
    const path = p.edge ? [p.edge.to.name, ...pathTo(reach, p.edge.to, key)] : [];
    if (key === UNVERIFIABLE) return unverifiable(unit, site, p.edge ? "calls" : p.use.verb, path, "error");
    const via = path.length > 0 ? `, reaching ${path.join(" → ")},` : "";
    return {
      severity: "error",
      code: "PERM003",
      file: unit.file,
      line: site.line,
      column: site.column,
      function: unit.name,
      capability: key,
      call: site.call,
      ...(path.length > 0 ? { path } : {}),
      message: `${unit.name} ${p.edge ? "calls" : p.use.verb} ${site.call}${via} but has no @perm annotation.`,
      fix: `add /** @perm ${key} */ to ${unit.name}.`,
    } satisfies Diagnostic;
  });
}

function annotationError(file: string, name: string, e: { text: string; reason: string; line: number; column: number }): Diagnostic {
  return {
    severity: "error",
    code: "PERM002",
    file,
    line: e.line,
    column: e.column,
    function: name,
    capability: e.text,
    call: "",
    message: `invalid @perm entry "${e.text}" on ${name}: ${e.reason}.`,
  };
}

/** One diagnostic per function, line, and capability; sorted by location. */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .filter((d) => {
      const key = [d.file, d.line, d.code, d.function, d.capability].join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}
