// What calling a declaration touches. Shared by direct calls (with their
// arguments), functions used as values (no arguments, so every scope is
// dynamic), and computed calls (to decide whether an object is sensitive).

import { Node } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { fetchCapability, isGlobalFetch } from "./fetch.js";
import { fsCapabilities, fsFunctionName } from "./fs.js";
import { prismaCapabilities } from "./prisma.js";
import { containerName, isGlobalLibFunction } from "./shared.js";

export function declarationCapabilities(declaration: Node, args: readonly Node[], adapters: AdapterIndex): Capability[] {
  if (isGlobalFetch(declaration)) return [fetchCapability(args)];
  if (runsArbitraryCode(declaration)) return [{ name: UNVERIFIABLE }];
  const fs = fsFunctionName(declaration);
  if (fs !== undefined) return fsCapabilities(fs, args);
  const db = prismaCapabilities(declaration);
  if (db.length > 0) return db;
  return adapters.forDeclaration(declaration, args);
}

/**
 * Built-ins that run code the checker can't see: `eval`, the `Function`
 * constructor, and `require` (its result is `any`, so nothing called on it can be
 * checked; use `import` instead).
 */
export function runsArbitraryCode(declaration: Node): boolean {
  if (isGlobalLibFunction(declaration, "eval")) return true;
  if (!declaration.getSourceFile().isDeclarationFile()) return false;
  const isSignature = Node.isCallSignatureDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration);
  if (!isSignature) return false;
  const container = containerName(declaration);
  return container === "FunctionConstructor" || container === "Require";
}

const TIMERS = ["setTimeout", "setInterval", "setImmediate"];

/** setTimeout and friends, which evaluate a string first argument as code. */
export function isTimer(declaration: Node): boolean {
  return TIMERS.some((name) => isGlobalLibFunction(declaration, name));
}
