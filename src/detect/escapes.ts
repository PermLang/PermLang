// Capabilities hidden behind `any`: `(globalThis as any).fetch(url)`,
// `(childProcess as any)["exec"]("ls")`, `const m: any = childProcess`.
//
// Once a value is typed `any`, nothing called on it can be resolved. But where it
// becomes `any`, the type checker still knows what it was. So the escape is
// checked there, for two kinds of value:
//
//   - The global objects (`globalThis`, `window`, `self`, `global`, `process`).
//     A member read straight off a cast is looked up on the original type:
//     `(self as any).fetch(url)` is a fetch call, with its host, and
//     `(process as any).env.KEY` reads env(KEY). Anything else is left alone:
//     these objects are cast to `any` all the time for harmless reasons
//     (`(window as any).dataLayer`, `const w = window as any`).
//   - A capability module (`import * as cp from "node:child_process"`). Named
//     members are looked up the same way. Any other escape (a computed member,
//     storing it, passing it on) loses track of it, and is unverifiable.
//
// A cast through `unknown` to a hand-written type (`x as unknown as { exec(): void }`)
// erases the original type just like `any` does, and is treated the same.
// Capability functions themselves (`fetch as any`) are value uses, handled in values.ts.

import { Node, SyntaxKind, type SourceFile, type Symbol as MorphSymbol, type Type } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { declarationCapabilities, requiresCapabilityModule } from "./functions.js";
import { argumentsOf, callText, literalString, resolveAlias, unwrapExpression, type CapabilityUse } from "./shared.js";
import { forEachDescendant } from "../walk.js";

export interface EscapeUse {
  node: Node;
  uses: CapabilityUse[];
}

/** Globals whose members include capabilities. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global", "process"]);

type Carrier = "global" | "module";

export function anyEscapes(sourceFile: SourceFile, adapters: AdapterIndex): EscapeUse[] {
  const out: EscapeUse[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
      // In `x as unknown as T`, the outer cast is the one that matters.
      if (Node.isAsExpression(outerOf(node).getParent()) || Node.isTypeAssertion(outerOf(node).getParent())) return;
      if (!erasesType(node.getType()) && !castsThroughUnknown(node)) return;
      const value = unwrapExpression(node);
      const carrier = carrierOf(value, adapters);
      if (!carrier) return;
      const member = memberUse(node, value, carrier, adapters);
      if (member) out.push(member);
      else if (member === undefined && carrier === "module") out.push(hidden(value));
      return;
    }
    // A capability module used where `any` is expected: `const m: any = cp`,
    // `m = cp` with `let m: any`, or `use(cp)` with `function use(m: any)`.
    if (Node.isIdentifier(node) && carrierOf(node, adapters) === "module" && isPassedAsAny(node)) out.push(hidden(node));
  });
  return out;
}

/** The outermost node of `node` wrapped in parentheses. */
function outerOf(node: Node): Node {
  let outer = node;
  while (Node.isParenthesizedExpression(outer.getParent())) outer = outer.getParentOrThrow();
  return outer;
}

/** `any`, or a record whose values are `any`: members read through it can't be resolved. */
function erasesType(type: Type): boolean {
  if (type.isAny()) return true;
  return type.getStringIndexType()?.isAny() === true || type.getNumberIndexType()?.isAny() === true;
}

/** `x as unknown as T`: the second cast replaces the original type with one the code wrote itself. */
function castsThroughUnknown(cast: Node): boolean {
  if (!Node.isAsExpression(cast) && !Node.isTypeAssertion(cast)) return false;
  let inner = cast.getExpression();
  while (Node.isParenthesizedExpression(inner)) inner = inner.getExpression();
  return (Node.isAsExpression(inner) || Node.isTypeAssertion(inner)) && (inner.getType().isUnknown() || inner.getType().isAny());
}

/** A global object from the standard library, or a namespace or default import of a capability module. */
function carrierOf(value: Node, adapters: AdapterIndex): Carrier | undefined {
  if (!Node.isIdentifier(value)) return undefined;
  const symbol = value.getSymbol();
  if (!symbol) return undefined;
  const declarations = symbol.getDeclarations();
  // `globalThis` is built into the checker and has no declaration; the others come from lib files.
  const builtin = declarations.length === 0 ? symbol.getName() === "globalThis" : declarations.every((d) => d.getSourceFile().isDeclarationFile());
  if (GLOBAL_OBJECTS.has(value.getText()) && builtin) return "global";
  for (const d of declarations) {
    if (!Node.isNamespaceImport(d) && !Node.isImportClause(d)) continue;
    const specifier = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
    if (specifier !== undefined && requiresCapabilityModule(specifier, adapters) && !adapters.isPure(specifier.replace(/^node:/, ""))) return "module";
  }
  return undefined;
}

/** A reference whose contextual type is `any`: an argument, assignment, or initializer that erases it. */
function isPassedAsAny(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (!parent || Node.isImportClause(parent) || Node.isNamespaceImport(parent) || identifier.getFirstAncestor((a) => Node.isTypeNode(a))) return false;
  // `cp as any` is the cast case above; `cp.exec`, `cp["exec"]` are normal calls.
  if (Node.isAsExpression(parent) || Node.isTypeAssertion(parent) || Node.isParenthesizedExpression(parent) || Node.isSatisfiesExpression(parent)) return false;
  if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === identifier) return false;
  if (!Node.isExpression(identifier)) return false;
  const contextual = identifier.getContextualType();
  return contextual !== undefined && erasesType(contextual);
}

/**
 * `(x as any).name(...)` or `(x as any)["name"]`: the member as the original type declares it.
 * Returns null for a member that isn't a capability, and undefined when the use isn't a single
 * named member (a module's escape is then reported as hidden).
 */
function memberUse(cast: Node, value: Node, carrier: Carrier, adapters: AdapterIndex): EscapeUse | null | undefined {
  const outer = outerOf(cast);
  const access = outer.getParent();
  if (!access) return undefined;

  let name: string | undefined;
  if (Node.isPropertyAccessExpression(access) && access.getExpression() === outer) name = access.getName();
  else if (Node.isElementAccessExpression(access) && access.getExpression() === outer) {
    name = literalString(access.getArgumentExpression());
    // A computed member. On a global, reading one (`(window as any)[key]`) is how apps read config;
    // calling one is already unverifiable as a computed call (detect/computed.ts).
    if (name === undefined) return carrier === "module" ? hidden(value) : null;
  } else return undefined;

  // Replacing a member (`(globalThis as any).fetch = mock`) isn't using it.
  const write = access.getParent();
  if (write && Node.isBinaryExpression(write) && write.getLeft() === access && write.getOperatorToken().getKind() === SyntaxKind.EqualsToken) return null;

  const property = value.getType().getProperty(name);
  // The original type has no such member. On a global it isn't one of its capabilities; on a
  // capability module it could be an API newer than its types (`(fs as any).someNewWrite()`).
  if (!property) return carrier === "module" ? hidden(value) : null;

  const env = envUse(property, access);
  if (env) return env;

  const call = access.getParent();
  const called = call !== undefined && Node.isCallExpression(call) && call.getExpression() === access;
  for (const declaration of resolveAlias(property).getDeclarations()) {
    const capabilities = declarationCapabilities(declaration, called ? argumentsOf(call) : [], adapters, called ? call : undefined);
    if (capabilities.length === 0) continue;
    const text = called ? callText(call) : `${access.getText().replace(/\s+/g, " ")} as a value`;
    return { node: called ? call : access, uses: capabilities.map((capability) => ({ capability, call: text, verb: called ? "calls" : "uses" })) };
  }
  // A member that is itself a global object (`(globalThis as any).process`): it could reach anything.
  if (GLOBAL_OBJECTS.has(name)) return hidden(value);
  return carrier === "module" && isModuleObject(property.getTypeAtLocation(access), adapters) ? hidden(value) : null;
}

/** `(process as any).env.KEY`, `(process as any).env`: the environment, read past the cast. */
function envUse(property: MorphSymbol, access: Node): EscapeUse | undefined {
  const type = property.getTypeAtLocation(access);
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol?.getName() !== "ProcessEnv" || !symbol.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile())) return undefined;
  const parent = access.getParent();
  const key =
    parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === access
      ? parent.getName()
      : parent && Node.isElementAccessExpression(parent) && parent.getExpression() === access
        ? literalString(parent.getArgumentExpression())
        : undefined;
  const site = key !== undefined && parent ? parent : access;
  const capability: Capability = key !== undefined ? { name: "env", arg: key } : { name: "env" };
  return { node: site, uses: [{ capability, call: site.getText().replace(/\s+/g, " "), verb: "reads" }] };
}

/** A namespace-like member of a capability module (`fs.promises`): its own members carry capabilities. */
function isModuleObject(type: Type, adapters: AdapterIndex): boolean {
  if (type.getCallSignatures().length > 0) return false;
  for (const d of type.getSymbol()?.getDeclarations() ?? []) {
    for (const m of [d, ...d.getAncestors()]) {
      if (!Node.isModuleDeclaration(m)) continue;
      const name = m.getNameNode();
      if (Node.isStringLiteral(name) && requiresCapabilityModule(name.getLiteralValue(), adapters)) return true;
    }
  }
  return false;
}

const unverifiable: Capability = { name: UNVERIFIABLE };

function hidden(value: Node): EscapeUse {
  const text = value.getText().replace(/\s+/g, " ");
  return { node: value, uses: [{ capability: unverifiable, call: `${text} cast to \`any\``, verb: "uses" }] };
}
