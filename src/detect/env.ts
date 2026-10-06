// Environment variables: any expression typed NodeJS.ProcessEnv, and Vite-style
// `import.meta.env` (typed ImportMetaEnv).
//
// Matching the type rather than the text `process.env` means aliases
// (`const env = process.env; env.KEY`) and `import { env } from "node:process"`
// are covered. So are patterns that take the environment out of what holds it
// (`const { env: { KEY } } = process`), which are read by the type of the inner
// pattern. Any use that can't be tied to one name needs bare `env`.
//
// Without types, the text still counts: `process.env` when `process` is the global
// (Node's types missing, or a project's own `declare const process`), also as
// `globalThis.process`, `global.process`, `process["env"]`, a const alias
// (`const p = process`), or a destructured name (`const { env } = process`); and
// `import.meta.env` (or `import.meta["env"]`, an alias, a destructured name) when
// nothing declares it.

import { Node, SyntaxKind, ts, type Identifier, type ObjectBindingPattern, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString, unwrapExpression, type CapabilityUse } from "./shared.js";
import { forEachDescendant } from "../walk.js";

export interface EnvUse {
  node: Node;
  uses: CapabilityUse[];
}

export function envUses(sourceFile: SourceFile): EnvUse[] {
  const out: EnvUse[] = [];
  forEachDescendant(sourceFile, (n) => {
    if (Node.isObjectBindingPattern(n) || Node.isObjectLiteralExpression(n)) {
      const found = nestedPattern(n);
      if (found) out.push(found);
      return;
    }
    if (!Node.isIdentifier(n) && !Node.isPropertyAccessExpression(n) && !Node.isElementAccessExpression(n)) return;
    if (isNameNode(n)) return;
    const typed = envType(n);
    const kind = typed ?? untypedEnv(n);
    if (!kind || n.getFirstAncestor((a) => Node.isTypeNode(a))) return;
    const found = classify(n, kind, typed !== undefined);
    if (found) out.push(found);
  });
  return out;
}

const named = (name: string): Capability => ({ name: "env", arg: name });
const dynamic: Capability = { name: "env", dynamic: true };

// What Vite itself sets in import.meta.env, from the build rather than the environment.
const VITE_BUILT_INS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

type Environment = "process" | "import.meta";

const read = (node: Node, capabilities: Capability[]): EnvUse => ({
  node,
  uses: capabilities.map((capability) => ({ capability, call: shorten(node.getText()), verb: "reads" })),
});

/** `typed`: the environment is recognized by its type, so aliases of it are found by theirs. */
function classify(env: Node, kind: Environment, typed: boolean): EnvUse | undefined {
  const parent = env.getParentOrThrow();
  const use = (node: Node, capabilities: Capability[]): EnvUse | undefined => (capabilities.length > 0 ? read(node, capabilities) : undefined);

  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === env) return use(parent, variable(kind, parent.getName()));
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === env) {
    return use(parent, variable(kind, literalString(parent.getArgumentExpression())));
  }
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === env) {
    const binding = parent.getNameNode();
    // `const env = process.env` is an alias; its uses are found through their type. Without one,
    // they can't be, so the alias itself reads every variable.
    if (Node.isIdentifier(binding)) return typed ? undefined : use(parent, [dynamic]);
    if (Node.isObjectBindingPattern(binding)) return use(parent, patternReads(binding, kind));
  }
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
    const key = literalString(parent.getLeft());
    if (parent.getRight() === env && key !== undefined) return use(parent, [named(key)]);
  }
  // Passed along, spread, enumerated: every variable is reachable.
  return use(parent, [dynamic]);
}

/** Reading variable `name` (undefined when it can't be known); Vite's own values aren't the environment. */
function variable(kind: Environment, name: string | undefined): Capability[] {
  if (name === undefined) return [dynamic];
  return kind === "import.meta" && VITE_BUILT_INS.has(name) ? [] : [named(name)];
}

/** The variables a destructuring pattern reads: each name, or every one for a rest element or a computed key. */
function patternReads(pattern: ObjectBindingPattern | ObjectLiteralExpression, kind: Environment): Capability[] {
  if (Node.isObjectBindingPattern(pattern)) {
    return pattern.getElements().flatMap((el) => (el.getDotDotDotToken() ? [dynamic] : variable(kind, keyOf(el.getPropertyNameNode() ?? el.getNameNode()))));
  }
  return pattern.getProperties().flatMap((p) => (Node.isSpreadAssignment(p) ? [dynamic] : variable(kind, keyOf(p.getNameNode()))));
}

/** A property's name as written (`KEY`, `"KEY"`, `["KEY"]`); undefined for a computed key that can't be read. */
function keyOf(name: Node): string | undefined {
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name) ? name.getLiteralValue() : name.getText();
}

/**
 * A pattern that takes the environment out of what holds it, at any depth:
 * `const { env: { KEY } } = process`, `({ env: { KEY: k } } = process)`, or a parameter
 * `({ env: { KEY } }: NodeJS.Process)`. (A pattern given the environment itself,
 * `const { KEY } = process.env`, is read where the environment is named, in classify.)
 */
function nestedPattern(pattern: ObjectBindingPattern | ObjectLiteralExpression): EnvUse | undefined {
  const nested = Node.isObjectBindingPattern(pattern) ? Node.isBindingElement(pattern.getParent()) : isNestedAssignmentTarget(pattern);
  if (!nested) return undefined;
  const kind = Node.isObjectBindingPattern(pattern) ? envType(pattern) ?? untypedNested(pattern) : assignedEnvType(pattern);
  const capabilities = kind ? patternReads(pattern, kind) : [];
  return capabilities.length > 0 ? read(pattern, capabilities) : undefined;
}

/** An object literal destructured into, inside another: the `{ KEY: k }` in `({ env: { KEY: k } } = process)`. */
function isNestedAssignmentTarget(literal: ObjectLiteralExpression): boolean {
  const property = literal.getParent();
  if (!Node.isPropertyAssignment(property) || property.getInitializer() !== literal) return false;
  let node: Node = property;
  for (let parent = node.getParent(); parent; node = parent, parent = parent.getParent()) {
    if (Node.isObjectLiteralExpression(parent) || Node.isArrayLiteralExpression(parent) || Node.isPropertyAssignment(parent)) continue;
    if (Node.isBinaryExpression(parent)) return parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getLeft() === node;
    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) return parent.getInitializer() === node;
    return false;
  }
  return false;
}

/** Typed as Node's ProcessEnv, or as ImportMetaEnv (vite/client, and the frameworks that copy it). */
function envType(node: Node): Environment | undefined {
  return environmentOf(node.getType().compilerType);
}

/** The type of what an object literal destructuring target is given, rather than of the literal itself. */
function assignedEnvType(literal: ObjectLiteralExpression): Environment | undefined {
  const checker = literal.getProject().getTypeChecker().compilerObject;
  return environmentOf(checker.getTypeOfAssignmentPattern(literal.compilerNode));
}

function environmentOf(type: ts.Type): Environment | undefined {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol?.getName() === "ImportMetaEnv") return "import.meta";
  const fromLib = symbol?.getName() === "ProcessEnv" && (symbol.getDeclarations() ?? []).some((d) => d.getSourceFile().isDeclarationFile);
  return fromLib ? "process" : undefined;
}

/**
 * The environment reached without types: `X.env` or `X["env"]` where X holds it untyped (see
 * untypedHolder), or a name destructured from one (`env` in `const { env } = process`).
 */
function untypedEnv(node: Node): Environment | undefined {
  if (Node.isIdentifier(node)) return destructuredEnv(node);
  const object =
    Node.isPropertyAccessExpression(node) && node.getName() === "env" ? node.getExpression()
    : Node.isElementAccessExpression(node) && literalString(node.getArgumentExpression()) === "env" ? node.getExpression()
    : undefined;
  // `(process as any).env` too: without types, the cast hides nothing more.
  return object && untypedHolder(unwrapExpression(object));
}

/** `env` in `const { env } = process`, or `e` in `const { env: e } = globalThis.process`, without types. */
function destructuredEnv(identifier: Identifier): Environment | undefined {
  const declaration = identifier.getSymbol()?.getDeclarations()[0];
  if (!Node.isBindingElement(declaration) || declaration.getDotDotDotToken()) return undefined;
  return keyOf(declaration.getPropertyNameNode() ?? declaration.getNameNode()) === "env" ? patternHolder(declaration.getParent()) : undefined;
}

/** `{ KEY }` in `const { env: { KEY } } = process`, without types. */
function untypedNested(pattern: ObjectBindingPattern): Environment | undefined {
  const element = pattern.getParent();
  if (!Node.isBindingElement(element)) return undefined;
  const key = element.getPropertyNameNode();
  return key && keyOf(key) === "env" ? patternHolder(element.getParent()) : undefined;
}

/** What a destructuring pattern is given, if it's the untyped holder of the environment. */
function patternHolder(pattern: Node): Environment | undefined {
  const owner = pattern.getParent();
  const initializer = Node.isVariableDeclaration(owner) || Node.isParameterDeclaration(owner) ? owner.getInitializer() : undefined;
  return initializer && untypedHolder(unwrapExpression(initializer));
}

/**
 * Whether an untyped expression holds the environment: the global `process` (also as
 * `globalThis.process` or `global.process`), `import.meta`, or a const alias of one
 * (`const p = process`).
 */
function untypedHolder(object: Node, depth = 0): Environment | undefined {
  if (object.getText() === "import.meta") return "import.meta";
  if (Node.isIdentifier(object) && object.getText() === "process") return isGlobalWithoutNodeTypes(object) ? "process" : undefined;
  if (Node.isPropertyAccessExpression(object)) {
    const owner = unwrapExpression(object.getExpression());
    const global = Node.isIdentifier(owner) && /^(globalThis|global)$/.test(owner.getText()) && isGlobalWithoutNodeTypes(owner);
    return global && object.getName() === "process" && isGlobalWithoutNodeTypes(object.getNameNode()) ? "process" : undefined;
  }
  if (!Node.isIdentifier(object) || depth > 8) return undefined;
  const declaration = object.getSymbol()?.getDeclarations()[0];
  const isConst = Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === "const";
  const initializer = isConst ? declaration.getInitializer() : undefined;
  return initializer && untypedHolder(unwrapExpression(initializer), depth + 1);
}

/**
 * A global name that isn't a local one: unresolved (Node's types missing), built in
 * (`globalThis`), or declared by the project itself (`declare const process: { env: ... }`),
 * which bundlers fill from the environment.
 */
function isGlobalWithoutNodeTypes(identifier: Node): boolean {
  const declarations = identifier.getSymbol()?.getDeclarations() ?? [];
  return declarations.every((d) => d.getSourceFile().isDeclarationFile() || (Node.isVariableDeclaration(d) && d.getVariableStatement()?.hasDeclareKeyword() === true));
}

/** The `env` in `process.env`, or a name being declared: not an expression of its own. */
function isNameNode(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === node;
  return "getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === node;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 70 ? `${oneLine.slice(0, 67)}...` : oneLine;
}
