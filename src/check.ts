// Compares each function's declared permissions with the capabilities it uses.
//
// M1 scope: direct calls only. A call inside an anonymous callback counts toward
// the nearest named function around it. Propagation through helpers is M2.

import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type CallExpression,
  type JSDoc,
  type SourceFile,
} from "ts-morph";
import { readPermAnnotation, type PermAnnotation } from "./annotations.js";
import { covers, formatCapability, type Capability } from "./capability.js";
import { detectCapabilities } from "./detect.js";

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

export interface Report {
  files: number;
  functions: FunctionReport[];
  diagnostics: Diagnostic[];
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

export function checkFiles(files: readonly string[]): Report {
  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  project.addSourceFilesAtPaths([...files]);
  return checkProject(project);
}

export function checkTsConfig(tsConfigFilePath: string): Report {
  return checkProject(new Project({ tsConfigFilePath }));
}

export function checkProject(project: Project): Report {
  const sourceFiles = project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !isInNodeModules(sf));
  const functions: FunctionReport[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const sourceFile of sourceFiles) {
    for (const unit of collectUnits(sourceFile)) {
      functions.push(summarize(unit));
      diagnostics.push(...diagnose(unit));
    }
  }

  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { files: sourceFiles.length, functions, diagnostics };
}

// --- units -------------------------------------------------------------------

interface Use {
  capability: Capability;
  call: string;
  line: number;
  column: number;
}

/** A named function, method, or the module's top level. */
interface Unit {
  file: string;
  name: string;
  line: number;
  annotation: PermAnnotation | undefined;
  uses: Use[];
}

function collectUnits(sourceFile: SourceFile): Unit[] {
  const file = sourceFile.getFilePath();
  const units = new Map<Node, Unit>();
  const unitFor = (node: Node): Unit => {
    let unit = units.get(node);
    if (!unit) {
      unit = {
        file,
        name: unitName(node),
        line: node.getStartLineNumber(),
        annotation: readPermAnnotation(jsDocsOf(node)),
        uses: [],
      };
      units.set(node, unit);
    }
    return unit;
  };

  // Register every annotated unit, including ones that use nothing.
  sourceFile.forEachDescendant((node) => {
    if (isUnitNode(node)) unitFor(node);
  });

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const found = detectCapabilities(call);
    if (found.length === 0) continue;
    const unit = unitFor(enclosingUnit(call));
    const { line, column } = sourceFile.getLineAndColumnAtPos(call.getStart());
    for (const { capability, call: text } of found) unit.uses.push({ capability, call: text, line, column });
  }

  // Unannotated units that use nothing are noise in the report.
  return [...units.values()].filter((u) => u.annotation !== undefined || u.uses.length > 0);
}

function isUnitNode(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    (Node.isVariableDeclaration(node) && isFunctionLike(node.getInitializer()))
  );
}

function isFunctionLike(node: Node | undefined): boolean {
  return node !== undefined && (Node.isArrowFunction(node) || Node.isFunctionExpression(node));
}

function enclosingUnit(node: Node): Node {
  for (const ancestor of node.getAncestors()) {
    if (isFunctionLike(ancestor) && Node.isVariableDeclaration(ancestor.getParent())) return ancestor.getParentOrThrow();
    if (isUnitNode(ancestor) || Node.isSourceFile(ancestor)) return ancestor;
  }
  return node.getSourceFile();
}

function unitName(node: Node): string {
  if (Node.isSourceFile(node)) return "<module>";
  if (Node.isConstructorDeclaration(node)) return `${className(node)}.constructor`;
  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return `${className(node)}.${node.getName()}`;
  }
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? "default";
  if (Node.isVariableDeclaration(node)) return node.getName();
  return "<anonymous>";
}

function className(node: Node): string {
  const parent = node.getParent();
  return parent && Node.isClassDeclaration(parent) ? (parent.getName() ?? "default") : "<class>";
}

function jsDocsOf(node: Node): JSDoc[] {
  if (Node.isVariableDeclaration(node)) return node.getVariableStatement()?.getJsDocs() ?? [];
  if (Node.isJSDocable(node)) return node.getJsDocs();
  return [];
}

function isInNodeModules(sf: SourceFile): boolean {
  return sf.getFilePath().split("/").includes("node_modules");
}

// --- diagnostics -------------------------------------------------------------

function summarize(unit: Unit): FunctionReport {
  const unique = (caps: Capability[]) => [...new Set(caps.map(formatCapability))];
  return {
    file: unit.file,
    name: unit.name,
    line: unit.line,
    annotated: unit.annotation !== undefined,
    declared: unique(unit.annotation?.capabilities ?? []),
    actual: unique(unit.uses.map((u) => u.capability)),
  };
}

function diagnose(unit: Unit): Diagnostic[] {
  const out: Diagnostic[] = [];
  const base = { file: unit.file, function: unit.name };

  for (const e of unit.annotation?.errors ?? []) {
    out.push({
      ...base,
      severity: "error",
      code: "PERM002",
      line: e.line,
      column: e.column,
      capability: e.text,
      call: "",
      message: `invalid @perm entry "${e.text}" on ${unit.name}: ${e.reason}.`,
    });
  }

  for (const use of unit.uses) {
    const capability = formatCapability(use.capability);
    const where = { ...base, line: use.line, column: use.column, capability, call: use.call };

    if (unit.annotation === undefined) {
      out.push({
        ...where,
        severity: "warning",
        code: "PERM003",
        message: `${unit.name} calls ${use.call} but has no @perm annotation.`,
        fix: `add /** @perm ${capability} */ to ${unit.name}.`,
      });
    } else if (!covers(unit.annotation.capabilities, use.capability)) {
      out.push({
        ...where,
        severity: "error",
        code: "PERM001",
        message: violationMessage(unit.name, use, capability),
        fix: `add ${capability} to @perm, or remove the call.`,
      });
    }
  }

  return out;
}

function violationMessage(name: string, use: Use, capability: string): string {
  if (use.capability.arg !== undefined) {
    return `${name} calls ${use.call}\n  but its declared permissions do not include ${capability}.`;
  }
  const what = use.capability.name === "net" ? "host" : "path";
  return `${name} calls ${use.call}\n  but its ${what} can't be determined statically, so it needs ${capability}.`;
}
