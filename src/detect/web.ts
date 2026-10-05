// Built-in APIs matched in code rather than by an adapter. They come from the
// TypeScript lib, @types/node, or undici-types (the types of Node's web globals),
// which have no adapter, and each needs more than a name match:
//
//   - WebSocket, EventSource, WebTransport, and WebSocketStream reach the host
//     they're given; navigator.sendBeacon and XMLHttpRequest's open send to theirs.
//   - The DOM's Worker and SharedWorker, and importScripts(), run a script the
//     checker can't see.
//   - setTimeout("code") evaluates its string, also as window.setTimeout.
//   - process.getBuiltinModule(name) with a computed name could return any module;
//     process.loadEnvFile() reads a file (./.env by default) into the environment.
//   - fs's ReadStream and WriteStream open a file but declare no constructor of
//     their own, so they're matched by the class constructed (see fs.ts).
//
// Constructors are matched by the signature a call resolves to, not by name, so
// aliases (`const WS = WebSocket`), subclasses, `typeof WebSocket` parameters, and
// `super(url)` are covered too.

import { Node, type Type } from "ts-morph";
import { packageOf, type AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { fsCapabilities, fsStreamClass } from "./fs.js";
import { declarationCapabilities } from "./functions.js";
import { argumentsOf, containerName, evaluatesString, hostOf, isGlobalLibFunction, literalString, resolveAlias, type CallLike } from "./shared.js";

const NETWORK_CLASSES = new Set(["WebSocket", "EventSource", "WebTransport", "WebSocketStream"]);
const SCRIPT_CLASSES = new Set(["Worker", "SharedWorker"]);
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

const unverifiable: Capability = { name: UNVERIFIABLE };

/** `declaration` is the resolved signature of `call`, if any. */
export function webCapabilities(call: CallLike, declaration: Node | undefined): Capability[] {
  const args = argumentsOf(call);
  if (Node.isNewExpression(call)) {
    const stream = fsStreamClass(call.getType());
    // A subclass's constructor may pass its base different arguments, so they aren't read.
    if (stream) return fsCapabilities(stream.name, stream.direct ? args : []);
    if (!declaration && constructsGlobal(call.getExpression())) return [net(args[0])];
  }
  return declaration ? platformCapabilities(declaration, args, true) : [];
}

/**
 * What calling a platform API that needs code touches; [] if `declaration` isn't one.
 * `called` is false for a function used as a value, whose arguments are unknown.
 */
export function platformCapabilities(declaration: Node, args: readonly Node[], called: boolean): Capability[] {
  const source = platformSource(declaration);
  if (!source) return [];
  const constructed = constructedClass(declaration);
  if (constructed !== undefined) {
    if (NETWORK_CLASSES.has(constructed)) return [net(args[0])];
    // Node's own Worker (worker_threads) has an adapter; this is the browser's.
    if (SCRIPT_CLASSES.has(constructed) && source !== "node") return [unverifiable];
    return [];
  }
  if (isGlobalLibFunction(declaration, "importScripts")) return [unverifiable];
  const name = "getName" in declaration ? (declaration as { getName(): string | undefined }).getName() : undefined;
  if (name === undefined) return [];
  if (called && TIMERS.has(name) && isTimer(declaration) && evaluatesString(args[0])) return [unverifiable];
  const container = containerName(declaration);
  if (name === "sendBeacon" && container === "Navigator") return [net(args[0])];
  if (name === "open" && container === "XMLHttpRequest") return [net(args[1])];
  if (container === "Process") return processCapabilities(name, args, called);
  return [];
}

/**
 * What calling `declaration` with `args` touches: a platform API matched here, or whatever
 * functions.ts finds. `call` is the call itself, when there is one.
 */
export function capabilitiesOf(declaration: Node, args: readonly Node[], adapters: AdapterIndex, call?: CallLike): Capability[] {
  const platform = platformCapabilities(declaration, args, call !== undefined);
  return platform.length > 0 ? platform : declarationCapabilities(declaration, args, adapters, call);
}

/**
 * What constructing a class of `type` touches: one used as a value (`Reflect.construct(WebSocket, ...)`),
 * with no arguments, or one constructed past a cast (`new (window as any).WebSocket(url)`).
 */
export function constructorCapabilities(type: Type, adapters: AdapterIndex, args: readonly Node[] = []): Capability[] {
  for (const signature of type.getConstructSignatures()) {
    const declaration = signature.getDeclaration();
    const capabilities = declaration ? capabilitiesOf(declaration, args, adapters) : [];
    if (capabilities.length > 0) return capabilities;
    const stream = fsStreamClass(signature.getReturnType());
    if (stream) return fsCapabilities(stream.name, stream.direct ? args : []);
  }
  return [];
}

function processCapabilities(name: string, args: readonly Node[], called: boolean): Capability[] {
  // A literal name is like importing the module: what's called on the result is checked.
  if (name === "getBuiltinModule") return literalString(args[0]) === undefined ? [unverifiable] : [];
  if (name === "loadEnvFile") {
    const path = called ? (args.length === 0 ? "./.env" : literalString(args[0])) : undefined;
    return [path === undefined ? { name: "fs.read", dynamic: true } : { name: "fs.read", arg: path }, { name: "env" }];
  }
  return [];
}

/** The class a constructor or construct signature builds: `WebSocket` for `declare var WebSocket: { new(...) }`. */
function constructedClass(declaration: Node): string | undefined {
  if (Node.isConstructorDeclaration(declaration)) {
    const owner = declaration.getParent();
    return Node.isClassDeclaration(owner) ? owner.getName() : undefined;
  }
  if (!Node.isConstructSignatureDeclaration(declaration)) return undefined;
  const owner = declaration.getParent();
  if (Node.isInterfaceDeclaration(owner)) return owner.getName().replace(/Constructor$/, "");
  const holder = owner?.getParent();
  return Node.isTypeLiteral(owner) && Node.isVariableDeclaration(holder) ? holder.getName() : undefined;
}

/**
 * Where a platform declaration comes from: the TypeScript lib, @types/node, undici-types (the
 * types of Node's web globals), or the project's own declaration files. Undefined for packages.
 */
function platformSource(declaration: Node): "lib" | "node" | "undici" | "project" | undefined {
  const file = declaration.getSourceFile();
  if (!file.isDeclarationFile()) return undefined;
  const filePath = file.getFilePath();
  if (filePath.includes("/node_modules/typescript/lib/")) return "lib";
  if (filePath.includes("/node_modules/@types/node/")) return "node";
  if (filePath.includes("/node_modules/undici-types/")) return "undici";
  return packageOf(declaration) === undefined ? "project" : undefined;
}

/** A global timer, or the same timer reached through `window` or `self`. */
function isTimer(declaration: Node): boolean {
  if ([...TIMERS].some((name) => isGlobalLibFunction(declaration, name))) return true;
  return Node.isMethodSignature(declaration) && containerName(declaration) === "WindowOrWorkerGlobalScope";
}

/** `new WebSocket(url)` whose signature couldn't be resolved, such as with too many arguments. */
function constructsGlobal(expression: Node): boolean {
  const symbol = expression.getSymbol();
  if (!symbol) return false;
  return resolveAlias(symbol)
    .getDeclarations()
    .some((d) => [...NETWORK_CLASSES].some((name) => isGlobalLibFunction(d, name)));
}

function net(arg: Node | undefined): Capability {
  const host = hostOf(arg);
  return host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host };
}
