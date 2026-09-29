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
  /** How messages describe the use: "calls fetch(...)" or "reads process.env.X". */
  verb: "calls" | "reads";
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
  return `${call.getExpression().getText()}(${shown})`.replace(/\s+/g, " ");
}

/** A string argument's literal value; undefined when it is computed. */
export function literalString(arg: Node | undefined): string | undefined {
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return arg.getLiteralValue();
  return undefined;
}

/** The declaration of the signature a call resolves to: the overload, method, or call signature actually used. */
export function resolvedDeclaration(call: CallLike): Node | undefined {
  try {
    return call.getProject().getTypeChecker().getResolvedSignature(call)?.getDeclaration();
  } catch {
    return undefined;
  }
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
