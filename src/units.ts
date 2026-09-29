// Units are the things permissions attach to: named functions, methods,
// constructors, accessors, function-valued variables and properties, and each
// file's top-level code. Anonymous callbacks belong to the unit around them.

import { Node, type JSDoc, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import { functionComments, moduleComments, readPermAnnotation, type PermAnnotation } from "./annotations.js";
import type { Capability } from "./capability.js";

export interface Use {
  capability: Capability;
  call: string;
  line: number;
  column: number;
}

export interface Unit {
  node: Node;
  file: string;
  name: string;
  line: number;
  /** Exported, or top-level code (which runs on import). */
  exported: boolean;
  /** The unit's own @perm tags. */
  own: PermAnnotation | undefined;
  /** The file's @module @perm tags, shared by every unit in the file. */
  module: PermAnnotation | undefined;
  /** Capabilities used directly in the unit's body. */
  uses: Use[];
}

export function isAnnotated(unit: Unit): boolean {
  return unit.own !== undefined || unit.module !== undefined;
}

export function declaredCapabilities(unit: Unit): Capability[] {
  return [...(unit.module?.capabilities ?? []), ...(unit.own?.capabilities ?? [])];
}

export function readModuleAnnotation(sourceFile: SourceFile): PermAnnotation | undefined {
  return readPermAnnotation(moduleComments(sourceFile), sourceFile);
}

export function createUnit(node: Node, module: PermAnnotation | undefined, exports: ReadonlySet<Node>): Unit {
  const sourceFile = node.getSourceFile();
  return {
    node,
    file: sourceFile.getFilePath(),
    name: unitName(node),
    line: Node.isSourceFile(node) ? 1 : node.getStartLineNumber(),
    exported: Node.isSourceFile(node) || exports.has(exportOwner(node)),
    own: Node.isSourceFile(node) ? undefined : readPermAnnotation(functionComments(jsDocsOf(node)), sourceFile),
    module,
    uses: [],
  };
}

// --- which nodes are units ---------------------------------------------------

export function isUnitNode(node: Node): boolean {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isConstructorDeclaration(node)) {
    return node.hasBody(); // overload signatures are not units
  }
  return (
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    (isFunctionHolder(node) && isFunctionLike(node.getInitializer()))
  );
}

/** Declarations that name a function value: `const f = () => ...`, `{ f: () => ... }`, `class { f = () => ... }`. */
function isFunctionHolder(node: Node) {
  return Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node);
}

function isFunctionLike(node: Node | undefined): boolean {
  return node !== undefined && (Node.isArrowFunction(node) || Node.isFunctionExpression(node));
}

/** The unit a node's code runs in: its nearest named function, else the file. */
export function enclosingUnitNode(node: Node): Node {
  for (const ancestor of node.getAncestors()) {
    const parent = ancestor.getParent();
    if (isFunctionLike(ancestor) && parent && isFunctionHolder(parent)) return parent;
    if (isUnitNode(ancestor) || Node.isSourceFile(ancestor)) return ancestor;
  }
  return node.getSourceFile();
}

/**
 * The unit a symbol refers to, if it is first-party code: resolves overloads to
 * their implementation and classes to their constructor. Undefined for anything
 * declared in a .d.ts or node_modules (third-party code is M3's adapters).
 */
export function unitNodeForSymbol(symbol: MorphSymbol): Node | undefined {
  for (const declaration of symbol.getDeclarations()) {
    const node = unitNodeForDeclaration(declaration);
    if (node) return node;
  }
  return undefined;
}

function unitNodeForDeclaration(d: Node): Node | undefined {
  const sf = d.getSourceFile();
  if (sf.isDeclarationFile() || isInNodeModules(sf)) return undefined;
  if ((Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d)) && !d.hasBody()) return d.getImplementation();
  if (Node.isClassDeclaration(d) || Node.isClassExpression(d)) return d.getConstructors().find((c) => c.hasBody());
  if (isUnitNode(d)) return d;
  const parent = d.getParent();
  if (isFunctionLike(d) && parent && isFunctionHolder(parent)) return parent;
  return undefined;
}

export function isInNodeModules(sf: SourceFile): boolean {
  return sf.getFilePath().split("/").includes("node_modules");
}

// --- names, comments, exports ------------------------------------------------

function unitName(node: Node): string {
  if (Node.isSourceFile(node)) return "<module>";
  if (Node.isConstructorDeclaration(node)) return `${ownerName(node)}.constructor`;
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? "default";
  if (Node.isVariableDeclaration(node)) return node.getName();
  if (
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isPropertyAssignment(node) ||
    Node.isPropertyDeclaration(node)
  ) {
    return `${ownerName(node)}.${node.getName()}`;
  }
  return "<anonymous>";
}

/** The class or object-holding variable a member belongs to. */
function owner(member: Node): Node | undefined {
  const parent = member.getParent();
  if (parent && (Node.isClassDeclaration(parent) || Node.isClassExpression(parent))) return parent;
  if (parent && Node.isObjectLiteralExpression(parent)) {
    const holder = parent.getParent();
    if (holder && Node.isVariableDeclaration(holder)) return holder;
  }
  return undefined;
}

function ownerName(member: Node): string {
  const o = owner(member);
  if (o && (Node.isClassDeclaration(o) || Node.isClassExpression(o))) return o.getName() ?? "default";
  if (o && Node.isVariableDeclaration(o)) return o.getName();
  return "<anonymous>";
}

/** The declaration whose export status decides the unit's: members follow their class or object. */
function exportOwner(node: Node): Node {
  if (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node)) return node;
  return owner(node) ?? node;
}

function jsDocsOf(node: Node): JSDoc[] {
  if (Node.isVariableDeclaration(node)) return node.getVariableStatement()?.getJsDocs() ?? [];
  const docs = Node.isJSDocable(node) ? node.getJsDocs() : [];
  // An overloaded function's @perm may sit on any of its signatures.
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return [...node.getOverloads().flatMap((o) => o.getJsDocs()), ...docs];
  }
  return docs;
}

/** Declarations exported from a file, including via `export { x }` and re-exports of local names. */
export function exportedDeclarations(sourceFile: SourceFile): Set<Node> {
  const out = new Set<Node>();
  for (const symbol of sourceFile.getExportSymbols()) {
    const resolved = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
    for (const d of resolved.getDeclarations()) out.add(d);
  }
  return out;
}
