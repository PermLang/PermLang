// The global fetch. A local function named `fetch` is not the network.

import { Node, type CallExpression } from "ts-morph";
import type { Capability } from "../capability.js";
import { hostOf, resolveAlias } from "./shared.js";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

export function fetchCapabilities(call: CallExpression): Capability[] {
  if (!isGlobalFetch(call)) return [];
  const host = hostOf(call.getArguments()[0]);
  return [host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host }];
}

function isGlobalFetch(call: CallExpression): boolean {
  const callee = call.getExpression();
  let nameNode: Node | undefined;
  if (Node.isIdentifier(callee) && callee.getText() === "fetch") {
    nameNode = callee;
  } else if (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "fetch" &&
    GLOBAL_OBJECTS.has(callee.getExpression().getText())
  ) {
    nameNode = callee.getNameNode();
  }
  if (!nameNode) return false;

  const symbol = nameNode.getSymbol();
  // Without type information, assume the global rather than silently passing.
  if (!symbol) return true;
  const declarations = resolveAlias(symbol).getDeclarations();
  return declarations.length === 0 || declarations.every((d) => d.getSourceFile().isDeclarationFile());
}
