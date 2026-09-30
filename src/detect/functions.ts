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
 * checked; use `import` instead). A call to require() with a harmless literal
 * specifier is let through by `requiresCapabilityModule`.
 */
export function runsArbitraryCode(declaration: Node): boolean {
  if (isGlobalLibFunction(declaration, "eval")) return true;
  if (!declaration.getSourceFile().isDeclarationFile()) return false;
  const isSignature = Node.isCallSignatureDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration);
  if (!isSignature) return false;
  const container = containerName(declaration);
  return container === "FunctionConstructor" || container === "Require";
}

export function isRequire(declaration: Node): boolean {
  return declaration.getSourceFile().isDeclarationFile() && Node.isCallSignatureDeclaration(declaration) && containerName(declaration) === "Require";
}

// Node built-ins whose functions carry capabilities, or run code the checker can't see.
const CAPABILITY_BUILTINS = new Set([
  "child_process", "fs", "fs/promises", "http", "https", "http2", "net", "tls", "dgram", "dns",
  "vm", "worker_threads", "cluster", "inspector", "module", "process",
]);

/**
 * Whether require(specifier)'s untyped result could reach a capability: a Node
 * built-in that has them, or a package an adapter maps. JSON, relative files, and
 * other packages resolve like an import does.
 */
export function requiresCapabilityModule(specifier: string | undefined, adapters: AdapterIndex): boolean {
  if (specifier === undefined) return true;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  const bare = specifier.replace(/^node:/, "");
  return CAPABILITY_BUILTINS.has(bare) || CAPABILITY_BUILTINS.has(bare.split("/")[0]!) || adapters.hasPackage(bare);
}

const TIMERS = ["setTimeout", "setInterval", "setImmediate"];

/** setTimeout and friends, which evaluate a string first argument as code. */
export function isTimer(declaration: Node): boolean {
  return TIMERS.some((name) => isGlobalLibFunction(declaration, name));
}
