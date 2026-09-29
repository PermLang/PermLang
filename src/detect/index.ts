// Finds every place in a file that directly uses a capability.
//
// Detection is by resolved symbol or signature, not by name: a local function
// called `fetch` is not the network, and `const post = axios.post` is still axios.

import { Node, type SourceFile } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import type { Capability } from "../capability.js";
import { envUses } from "./env.js";
import { fetchCapabilities } from "./fetch.js";
import { fsCapabilities } from "./fs.js";
import { prismaCapabilities } from "./prisma.js";
import { callText, resolvedDeclaration, type CallLike, type CapabilityUse } from "./shared.js";

export type { CapabilityUse } from "./shared.js";

export interface DetectedUse {
  /** Where the use is; its enclosing unit is charged with it. */
  node: Node;
  uses: CapabilityUse[];
}

export function detectInFile(sourceFile: SourceFile, adapters: AdapterIndex): DetectedUse[] {
  const found: DetectedUse[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const capabilities = callCapabilities(node, adapters);
    if (capabilities.length === 0) return;
    const call = callText(node);
    found.push({ node, uses: capabilities.map((capability) => ({ capability, call, verb: "calls" })) });
  });
  found.push(...envUses(sourceFile));
  return found;
}

function callCapabilities(call: CallLike, adapters: AdapterIndex): Capability[] {
  if (Node.isCallExpression(call)) {
    const direct = [...fetchCapabilities(call), ...fsCapabilities(call)];
    if (direct.length > 0) return direct;
  }
  const declaration = resolvedDeclaration(call);
  const db = prismaCapabilities(declaration);
  return db.length > 0 ? db : adapters.capabilities(call, declaration);
}
