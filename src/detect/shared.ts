// Helpers shared by the detectors.

import {
  Node,
  type CallExpression,
  type NewExpression,
  type Symbol as MorphSymbol,
  type TaggedTemplateExpression,
} from "ts-morph";
import type { Capability } from "../capability.js";

export type CallLike = CallExpression | NewExpression | TaggedTemplateExpression;

export interface CapabilityUse {
  capability: Capability;
  /** The code as written, shortened for messages. */
  call: string;
  /** How messages describe the use: "calls fetch(...)", "reads process.env.X", "uses fetch as a value". */
  verb: "calls" | "reads" | "uses";
}

export function resolveAlias(symbol: MorphSymbol): MorphSymbol {
  return symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
}

export function argumentsOf(call: CallLike): Node[] {
  return Node.isTaggedTemplateExpression(call) ? [] : call.getArguments();
}

export function callText(call: CallLike): string {
  if (Node.isTaggedTemplateExpression(call)) return `${call.getTag().getText()}\`...\``;
  const args = call.getArguments();
  const first = args[0]?.getText() ?? "";
  const shown = (first.length > 60 ? `${first.slice(0, 57)}...` : first) + (args.length > 1 ? ", ..." : "");
  const prefix = Node.isNewExpression(call) ? "new " : "";
  return `${prefix}${call.getExpression().getText()}(${shown})`.replace(/\s+/g, " ");
}

/**
 * A string argument's value when it is known statically: a literal, or an
 * expression whose type is a single string literal (`const PATH = "a.json"`).
 * Undefined when it is computed.
 */
export function literalString(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
  const type = arg.getType();
  return type.isStringLiteral() ? String(type.getLiteralValue()) : undefined;
}

// Several passes resolve the same calls; signature resolution is the expensive part.
const resolved = new WeakMap<Node, Node | undefined>();

/** The declaration of the signature a call resolves to: the overload, method, or call signature actually used. */
export function resolvedDeclaration(call: CallLike): Node | undefined {
  if (resolved.has(call)) return resolved.get(call);
  let declaration: Node | undefined;
  try {
    declaration = call.getProject().getTypeChecker().getResolvedSignature(call)?.getDeclaration();
  } catch {
    declaration = undefined;
  }
  resolved.set(call, declaration);
  return declaration;
}

/**
 * A global function or variable from the TypeScript lib or @types/node, such as
 * `fetch` or `eval`: declared in a .d.ts, and not inside a `declare module "x"`
 * package block (`declare global` is fine).
 */
export function isGlobalLibFunction(declaration: Node, name: string): boolean {
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return false;
  if (declaration.getName() !== name || !declaration.getSourceFile().isDeclarationFile()) return false;
  // @types/node nests some globals as `declare module "timers" { global { function setTimeout ... } }`.
  for (const a of declaration.getAncestors()) {
    if (!Node.isModuleDeclaration(a)) continue;
    if (a.getName() === "global") return true;
    if (Node.isStringLiteral(a.getNameNode())) return false;
  }
  return true;
}

/** Strips parentheses, `as`, `!`, and `satisfies` to reach the expression underneath. */
export function unwrapExpression(node: Node): Node {
  let n = node;
  while (
    Node.isParenthesizedExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isTypeAssertion(n) ||
    Node.isNonNullExpression(n) ||
    Node.isSatisfiesExpression(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

/** The name of the nearest class, interface, type alias, or namespace a declaration sits in. */
export function containerName(declaration: Node): string | undefined {
  for (const a of declaration.getAncestors()) {
    if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeAliasDeclaration(a)) return a.getName();
    if (Node.isModuleDeclaration(a)) return Node.isStringLiteral(a.getNameNode()) ? undefined : a.getName();
  }
  return undefined;
}

// Host is known only when the literal text fixes it, i.e. something ends the host
// before any substitution. `https://api.stripe.com${x}` could become any host.
const TEMPLATE_HOST = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@\s]+)(?=[/?#:])/i;

/**
 * The host an argument names: a URL string or template, or an options object
 * with a literal `url`, `hostname`, or `host`. Undefined when it can't be known.
 */
export function hostOf(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  const text = literalString(arg);
  if (text !== undefined) {
    try {
      return new URL(text).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isTemplateExpression(arg)) {
    return TEMPLATE_HOST.exec(arg.getHead().getLiteralText())?.[1]?.toLowerCase();
  }
  if (Node.isObjectLiteralExpression(arg)) {
    const prop = (name: string) => {
      const p = arg.getProperty(name);
      return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
    };
    const url = prop("url");
    if (url) return hostOf(url);
    const host = literalString(prop("hostname")) ?? literalString(prop("host"));
    // `host` may carry a port: "internal.example:8080".
    return host?.replace(/:\d+$/, "").toLowerCase() || undefined;
  }
  return undefined;
}
