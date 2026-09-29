// Compares each function's declared permissions with everything it can reach.
//
// A unit's actual permissions are its direct uses plus everything its callees
// reach, across files. Declared permissions are the unit's own @perm tags plus
// its file's @module @perm tags.

import { Project, ts, type Node } from "ts-morph";
import { AdapterError, AdapterIndex, loadAdapters } from "./adapters.js";
import { covers, formatCapability } from "./capability.js";
import { detectInFile } from "./detect/index.js";
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
  /** PERM001 undeclared capability, PERM002 invalid annotation, PERM003 missing annotation. */
  code: "PERM001" | "PERM002" | "PERM003";
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

export interface CheckOptions {
  /** Team adapter manifests, loaded before (and taking precedence over) the built-in ones. */
  adapters?: readonly string[];
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

export function checkFiles(files: readonly string[], options: CheckOptions = {}): Report {
  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  project.addSourceFilesAtPaths([...files]);
  return checkProject(project, options);
}

export function checkTsConfig(tsConfigFilePath: string, options: CheckOptions = {}): Report {
  return checkProject(new Project({ tsConfigFilePath }), options);
}

/** @throws AdapterError when an adapter manifest is invalid. */
export function checkProject(project: Project, options: CheckOptions = {}): Report {
  const loaded = loadAdapters(options.adapters ?? []);
  if (loaded.errors.length > 0) throw new AdapterError(loaded.errors);
  const adapters = new AdapterIndex(loaded.adapters);

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
  const edges = sourceFiles.flatMap((sf) => collectEdges(sf, (node) => units.get(node)));
  const reach = propagate(units.values(), edges);
  const edgesFrom = groupBy(edges, (e) => e.from);

  // 3. Compare declared with actual.
  const functions: FunctionReport[] = [];
  for (const unit of units.values()) {
    const reached = reach.get(unit)!;
    if (!isAnnotated(unit) && reached.size === 0) continue;
    functions.push(summarize(unit, reach));
    diagnostics.push(...diagnose(unit, edgesFrom.get(unit) ?? [], reach));
  }

  const unsafe = [...units.values()].flatMap((u) =>
    u.own?.unsafe ? [{ file: u.file, line: u.own.unsafe.line, function: u.name, reason: u.own.unsafe.reason }] : [],
  );
  unsafe.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return { files: sourceFiles.length, functions, diagnostics: dedupe(diagnostics), unsafe };
}

// --- diagnostics -------------------------------------------------------------

function summarize(unit: Unit, reach: Reach): FunctionReport {
  return {
    file: unit.file,
    name: unit.name,
    line: unit.line,
    annotated: isAnnotated(unit),
    declared: [...new Set(declaredCapabilities(unit).map(formatCapability))],
    actual: [...reach.get(unit)!.keys()],
  };
}

function diagnose(unit: Unit, edges: readonly Edge[], reach: Reach): Diagnostic[] {
  const out: Diagnostic[] = (unit.own?.errors ?? []).map((e) => annotationError(unit.file, unit.name, e));

  if (!isAnnotated(unit)) {
    if (unit.exported) out.push(...missingAnnotation(unit, reach));
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

/** One warning per capability an exported, unannotated unit reaches, at the first place it does. */
function missingAnnotation(unit: Unit, reach: Reach): Diagnostic[] {
  return [...reach.get(unit)!].map(([key, p]) => {
    const site = p.edge ?? p.use;
    const path = p.edge ? [p.edge.to.name, ...pathTo(reach, p.edge.to, key)] : [];
    const via = path.length > 0 ? `, reaching ${path.join(" → ")},` : "";
    return {
      severity: "warning",
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
