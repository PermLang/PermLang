// Units are the things permissions attach to: named functions, methods,
// constructors, accessors, function-valued variables and properties, and each
// file's top-level code. Anonymous callbacks belong to the unit around them.

import { Node, ts, type ClassDeclaration, type ClassExpression, type JSDoc, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import { functionComments, moduleComments, readPermAnnotation, type PermAnnotation } from "./annotations.js";
import { UNVERIFIABLE, type Capability } from "./capability.js";

export interface Use {
  verb: "calls" | "reads" | "uses";
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
  /**
   * Declared in one of the project's own .d.ts files, for JavaScript the checker doesn't
   * analyze, so it's unverifiable. Calls reach it, but it isn't reported or locked itself.
   */
  declarationOnly?: true;
}

export function isAnnotated(unit: Unit): boolean {
  return unit.own !== undefined || unit.module !== undefined;
}

export function declaredCapabilities(unit: Unit): Capability[] {
  return [...(unit.module?.capabilities ?? []), ...(unit.own?.capabilities ?? [])];
}

export function readModuleAnnotation(sourceFile: SourceFile, vocabulary: ReadonlySet<string>): PermAnnotation | undefined {
  return readPermAnnotation(moduleComments(sourceFile), sourceFile, vocabulary);
}

export function createUnit(
  node: Node,
  module: PermAnnotation | undefined,
  exports: ReadonlySet<Node>,
  vocabulary: ReadonlySet<string>,
): Unit {
  const sourceFile = node.getSourceFile();
  return {
    node,
    file: sourceFile.getFilePath(),
    name: unitName(node),
    line: Node.isSourceFile(node) ? 1 : node.getStartLineNumber(),
    exported: isExported(node, exports),
    own: Node.isSourceFile(node) || isClass(node) ? undefined : readPermAnnotation(functionComments(jsDocsOf(node)), sourceFile, vocabulary),
    module,
    uses: [],
  };
}

// --- which nodes are units ---------------------------------------------------

export function isUnitNode(node: Node): boolean {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isConstructorDeclaration(node)) {
    return node.hasBody(); // overload signatures are not units
  }
  // A class with no constructor has an implicit one: it runs field initializers and the base constructor.
  if (isClass(node)) return !hasExplicitConstructor(node);
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

function isClass(node: Node): node is ClassDeclaration | ClassExpression {
  return Node.isClassDeclaration(node) || Node.isClassExpression(node);
}

function hasExplicitConstructor(cls: ClassDeclaration | ClassExpression): boolean {
  return cls.getConstructors().some((c) => c.hasBody());
}

/** The unit for a class's constructor: the explicit one, or the class itself as its implicit constructor. */
export function constructorUnitNode(cls: ClassDeclaration | ClassExpression): Node {
  return cls.getConstructors().find((c) => c.hasBody()) ?? cls;
}

/**
 * The unit a node's code runs in: its nearest named function, else the file.
 * Instance field initializers run in the constructor; static ones and class
 * bodies run where the class is defined.
 */
export function enclosingUnitNode(node: Node): Node {
  for (const ancestor of node.getAncestors()) {
    const parent = ancestor.getParent();
    if (isFunctionLike(ancestor) && parent && isFunctionHolder(parent)) return parent;
    if (Node.isPropertyDeclaration(ancestor) && !ancestor.isStatic() && parent && isClass(parent)) {
      return constructorUnitNode(parent);
    }
    if (isClass(ancestor)) continue;
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

/** Every unit a symbol refers to: a property with both a getter and a setter has two. */
export function unitNodesForSymbol(symbol: MorphSymbol): Node[] {
  return [...new Set(symbol.getDeclarations().map(unitNodeForDeclaration).filter((n): n is Node => n !== undefined))];
}

export function unitNodeForDeclaration(d: Node): Node | undefined {
  const sf = d.getSourceFile();
  if (isInNodeModules(sf)) return undefined;
  if (sf.isDeclarationFile()) return declaredUnitNode(d);
  if ((Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d)) && !d.hasBody()) return d.getImplementation();
  if (isClass(d)) return constructorUnitNode(d);
  if (isUnitNode(d)) return d;
  const parent = d.getParent();
  if (isFunctionLike(d) && parent && isFunctionHolder(parent)) return parent;
  return undefined;
}

export function isInNodeModules(sf: SourceFile): boolean {
  return sf.getFilePath().split("/").includes("node_modules");
}

// --- JavaScript declared in the project's own .d.ts files -------------------

/**
 * The unit a value declared in a .d.ts module stands for: a function (all of its
 * overloads), a class's constructor (the class), a class member, or a variable
 * (including everything in its type). Members of interfaces and type aliases have none:
 * they're types, whose implementations dispatch finds. Ambient declarations
 * (`declare module "x"`, `declare global`, or a .d.ts with no imports or exports)
 * describe packages and what the runtime provides, not the project's code.
 */
function declaredUnitNode(d: Node): Node | undefined {
  if (!ts.isExternalModule(d.getSourceFile().compilerNode)) return undefined;
  const chain = [d, ...d.getAncestors()];
  if (chain.some((n) => Node.isModuleDeclaration(n) && (Node.isStringLiteral(n.getNameNode()) || n.getName() === "global"))) return undefined;
  const holder = chain.find(
    (n) =>
      Node.isFunctionDeclaration(n) || Node.isVariableDeclaration(n) || Node.isClassDeclaration(n) || Node.isConstructorDeclaration(n) ||
      Node.isMethodDeclaration(n) || Node.isPropertyDeclaration(n) || Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n),
  );
  if (!holder) return undefined;
  if (Node.isConstructorDeclaration(holder)) return holder.getParent();
  // Overloads are one unit: the first declaration of the same kind.
  return holder.getSymbol()?.getDeclarations().find((x) => x.getKind() === holder.getKind()) ?? holder;
}

/** A unit for JavaScript declared in a .d.ts: reaching it is unverifiable. */
export function createDeclaredUnit(node: Node): Unit {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  const call = `JavaScript declared in ${sourceFile.getBaseName()}`;
  return {
    node,
    file: sourceFile.getFilePath(),
    name: unitName(node),
    line,
    exported: false,
    own: undefined,
    module: undefined,
    uses: [{ verb: "calls", capability: { name: UNVERIFIABLE }, call, line, column }],
    declarationOnly: true,
  };
}

/**
 * Whether a .d.ts describes the project's own code rather than a dependency: its nearest
 * package.json is also the nearest one for some file being checked. A generated client in
 * a folder with its own package.json (Prisma's custom output), or another workspace
 * package's build output, is a dependency.
 */
export function ownDeclarationFiles(sourceFiles: readonly SourceFile[]): (declarationFile: SourceFile) => boolean {
  const roots = new Map<string, string>();
  const project = sourceFiles[0]?.getProject();
  const rootOf = (dir: string): string => {
    const known = roots.get(dir);
    if (known !== undefined) return known;
    // ts-morph paths use `/`, with a drive letter on Windows: C:/app/src → C:/app → C:.
    const slash = dir.lastIndexOf("/");
    const parent = slash > 0 ? dir.slice(0, slash) : undefined;
    const root = project?.getFileSystem().fileExistsSync(`${dir}/package.json`) ? dir : parent === undefined ? "" : rootOf(parent);
    roots.set(dir, root);
    return root;
  };
  const own = new Set(sourceFiles.map((sf) => rootOf(sf.getDirectoryPath())));
  return (declarationFile) => own.has(rootOf(declarationFile.getDirectoryPath()));
}

// --- names, comments, exports ------------------------------------------------

function unitName(node: Node): string {
  if (Node.isSourceFile(node)) return "<module>";
  if (isClass(node)) return `${className(node)}.constructor`;
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

/**
 * What a member belongs to: its class, or the declaration holding its object
 * literal or class expression (`const api = {...}`, `export const C = class {...}`,
 * `export default {...}`).
 */
function owner(member: Node): Node | undefined {
  const parent = member.getParent();
  if (!parent) return undefined;
  if (Node.isClassDeclaration(parent)) return parent;
  if (Node.isClassExpression(parent) || Node.isObjectLiteralExpression(parent)) {
    const holder = parent.getParent();
    if (holder && (Node.isVariableDeclaration(holder) || Node.isExportAssignment(holder))) return holder;
    return Node.isClassExpression(parent) ? parent : undefined;
  }
  return undefined;
}

function ownerName(member: Node): string {
  const o = owner(member);
  if (o && (Node.isClassDeclaration(o) || Node.isClassExpression(o))) return className(o);
  if (o && Node.isVariableDeclaration(o)) return o.getName();
  if (o && Node.isExportAssignment(o)) return "default";
  return "<anonymous>";
}

/** The declaration whose export status decides the unit's: members follow their class or object. */
function exportOwner(node: Node): Node {
  if (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node)) return node;
  return owner(node) ?? node;
}

/**
 * Whether a unit can be reached from outside its file. Beyond what the file
 * exports directly: members of exported namespaces, and members of an object
 * literal a function creates and hands back (`return { get: () => fetch(...) }`),
 * which escape with that function.
 */
function isExported(node: Node, exports: ReadonlySet<Node>): boolean {
  if (Node.isSourceFile(node)) return true;
  const decisive = exportOwner(node);
  if (exports.has(decisive) || exportedThroughNamespace(decisive)) return true;
  const parent = node.getParent();
  if (parent && Node.isObjectLiteralExpression(parent) && owner(node) === undefined) {
    const creator = enclosingUnitNode(parent);
    return !Node.isSourceFile(creator) && isExported(creator, exports);
  }
  return false;
}

/** `export namespace Api { export function ping() {} }`, at any depth. */
function exportedThroughNamespace(node: Node): boolean {
  const statement = Node.isVariableDeclaration(node) ? node.getVariableStatement() : node;
  if (!statement || !Node.isExportable(statement) || !statement.hasExportKeyword()) return false;
  const block = statement.getParent();
  const namespace = block?.getParent();
  if (!block || !Node.isModuleBlock(block) || !namespace || !Node.isModuleDeclaration(namespace)) return false;
  const outer = namespace.getParent();
  if (outer && Node.isSourceFile(outer)) return namespace.hasExportKeyword();
  return exportedThroughNamespace(namespace);
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

/** A class's name, or for `const C = class {...}`, the variable's. */
function className(cls: ClassDeclaration | ClassExpression): string {
  const holder = cls.getParent();
  return cls.getName() ?? (holder && Node.isVariableDeclaration(holder) ? holder.getName() : "default");
}
