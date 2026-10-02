// The global fetch. A local function named `fetch` is not the network.

import { Node, type CallExpression } from "ts-morph";
import type { Capability } from "../capability.js";
import { hostOf, isGlobalLibFunction } from "./shared.js";

/** The capability of calling fetch with `args`; no args means fetch used as a value. */
export function fetchCapability(args: readonly Node[]): Capability {
  const host = hostOf(args[0]);
  return host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host };
}

/** The global fetch from lib.dom or @types/node, however it was reached. */
export function isGlobalFetch(declaration: Node): boolean {
  if (isGlobalLibFunction(declaration, "fetch")) return true;
  // `window.fetch` and `self.fetch` resolve to the method lib.dom and lib.webworker declare on
  // WindowOrWorkerGlobalScope, not to the global function.
  if (!Node.isMethodSignature(declaration) || declaration.getName() !== "fetch") return false;
  if (!declaration.getSourceFile().isDeclarationFile()) return false;
  const owner = declaration.getParent();
  return Node.isInterfaceDeclaration(owner) && owner.getName() === "WindowOrWorkerGlobalScope";
}

/**
 * Without type information (no lib or @types/node), assume a bare `fetch` or
 * `globalThis.fetch` that doesn't resolve is the global rather than silently passing.
 */
export function isUnresolvedFetch(call: CallExpression): boolean {
  const callee = call.getExpression();
  const nameNode = Node.isIdentifier(callee)
    ? callee
    : Node.isPropertyAccessExpression(callee) && /^(globalThis|window|self|global)$/.test(callee.getExpression().getText())
      ? callee.getNameNode()
      : undefined;
  return nameNode?.getText() === "fetch" && nameNode.getSymbol() === undefined;
}
