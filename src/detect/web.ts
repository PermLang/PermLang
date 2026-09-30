// Browser-style network globals, also available in Node: WebSocket, EventSource,
// navigator.sendBeacon, and XMLHttpRequest. Found in the pre-release review; they
// come from the TypeScript lib or @types/node, which have no adapter.

import { Node } from "ts-morph";
import type { Capability } from "../capability.js";
import { argumentsOf, containerName, hostOf, isGlobalLibFunction, resolveAlias, type CallLike } from "./shared.js";

const CONSTRUCTORS = ["WebSocket", "EventSource"];

/** `declaration` is the resolved signature of `call`, if any. */
export function webCapabilities(call: CallLike, declaration: Node | undefined): Capability[] {
  const args = argumentsOf(call);
  if (Node.isNewExpression(call) && constructsGlobal(call.getExpression())) return [net(args[0])];
  if (!declaration || !declaration.getSourceFile().isDeclarationFile()) return [];
  const name = "getName" in declaration ? (declaration as { getName(): string }).getName() : undefined;
  const container = containerName(declaration);
  if (name === "sendBeacon" && container === "Navigator") return [net(args[0])];
  if (name === "open" && container === "XMLHttpRequest") return [net(args[1])];
  return [];
}

function constructsGlobal(expression: Node): boolean {
  const symbol = expression.getSymbol();
  if (!symbol) return false;
  return resolveAlias(symbol)
    .getDeclarations()
    .some((d) => CONSTRUCTORS.some((name) => isGlobalLibFunction(d, name)));
}

function net(arg: Node | undefined): Capability {
  const host = hostOf(arg);
  return host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host };
}
