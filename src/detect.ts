// Maps a single call expression to the capabilities it uses directly.
//
// Callees are resolved through the type checker, not matched by name: a local
// function called `fetch` is not the network, and `import { writeFile as save }`
// is still a file write. M1 covers the global fetch and Node's fs modules.

import { Node, type CallExpression, type NewExpression, type Symbol as MorphSymbol } from "ts-morph";
import type { Capability } from "./capability.js";

export interface CapabilityUse {
  capability: Capability;
  /** The call as written, shortened for messages. */
  call: string;
}

export function detectCapabilities(call: CallExpression): CapabilityUse[] {
  const text = callText(call);
  if (isGlobalFetch(call)) {
    return [{ capability: { name: "net", arg: hostOf(call.getArguments()[0]) }, call: text }];
  }
  const fsFunction = fsFunctionName(call);
  if (fsFunction !== undefined) {
    return fsCapabilities(fsFunction, call).map((capability) => ({ capability, call: text }));
  }
  return [];
}

// --- network -----------------------------------------------------------------

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

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

// Host is known only when the literal text fixes it, i.e. something ends the host
// before any substitution. `https://api.stripe.com${x}` could become any host.
const TEMPLATE_HOST = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@\s]+)(?=[/?#:])/i;

function hostOf(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    try {
      return new URL(arg.getLiteralValue()).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isTemplateExpression(arg)) {
    return TEMPLATE_HOST.exec(arg.getHead().getLiteralText())?.[1]?.toLowerCase();
  }
  return undefined;
}

// --- file system -------------------------------------------------------------

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/** The fs function a call resolves to, or undefined if it is not an fs call. */
function fsFunctionName(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  const nameNode = Node.isIdentifier(callee)
    ? callee
    : Node.isPropertyAccessExpression(callee)
      ? callee.getNameNode()
      : undefined;
  const symbol = nameNode?.getSymbol();
  if (!symbol) return undefined;
  const resolved = resolveAlias(symbol);
  return resolved.getDeclarations().some(isInFsModule) ? resolved.getName() : undefined;
}

/**
 * A function exported by an fs module itself. Members of the objects fs returns
 * (`Stats.isDirectory`, `FileHandle.read`, streams) are excluded: they act on
 * something already opened or read, where the access was checked.
 */
function isInFsModule(declaration: Node): boolean {
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return false;
  for (const a of declaration.getAncestors()) {
    if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeLiteral(a)) return false;
    if (Node.isModuleDeclaration(a) && FS_MODULES.has(a.getName().replace(/^["']|["']$/g, ""))) return true;
  }
  return false;
}

// Operations on an open descriptor add no access; it was granted at open().
const FD_ONLY = new Set([
  "close", "fsync", "fdatasync", "fstat", "read", "readv", "write", "writev",
  "ftruncate", "fchmod", "fchown", "futimes",
]);
const READS = new Set([
  "readFile", "readdir", "stat", "lstat", "statfs", "exists", "access", "createReadStream",
  "watch", "watchFile", "unwatchFile", "realpath", "readlink", "opendir", "glob", "openAsBlob",
]);
// Source is read, destination is written.
const COPIES = new Set(["copyFile", "cp"]);
// Every path argument is written.
const TWO_PATH_WRITES = new Set(["rename", "link", "symlink"]);

function fsCapabilities(fn: string, call: CallExpression): Capability[] {
  const base = fn.replace(/Sync$/, "");
  const args = call.getArguments();
  const read = (i: number): Capability => ({ name: "fs.read", arg: pathOf(args[i]) });
  const write = (i: number): Capability => ({ name: "fs.write", arg: pathOf(args[i]) });

  if (FD_ONLY.has(base)) return [];
  if (READS.has(base)) return [read(0)];
  if (COPIES.has(base)) return [read(0), write(1)];
  if (TWO_PATH_WRITES.has(base)) return [write(0), write(1)];
  if (base === "open") return openCapabilities(args[1], read(0), write(0));
  // Everything else (writeFile, mkdir, rm, unlink, chmod, and anything unrecognized)
  // is treated as a write, so an unknown fs function never passes silently.
  return [write(0)];
}

function openCapabilities(flags: Node | undefined, read: Capability, write: Capability): Capability[] {
  if (!flags) return [read];
  if (Node.isStringLiteral(flags) || Node.isNoSubstitutionTemplateLiteral(flags)) {
    const f = flags.getLiteralValue();
    const caps: Capability[] = [];
    if (f.includes("r") || f.includes("+")) caps.push(read);
    if (/[wax+]/.test(f)) caps.push(write);
    return caps.length > 0 ? caps : [read, write];
  }
  return [read, write];
}

/** A path argument's literal value; undefined when it is computed. */
function pathOf(arg: Node | undefined): string | undefined {
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return arg.getLiteralValue();
  return undefined;
}

// --- helpers -----------------------------------------------------------------

export function resolveAlias(symbol: MorphSymbol): MorphSymbol {
  return symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
}

export function callText(call: CallExpression | NewExpression): string {
  const args = call.getArguments();
  const first = args[0]?.getText() ?? "";
  const shown = (first.length > 60 ? `${first.slice(0, 57)}...` : first) + (args.length > 1 ? ", ..." : "");
  const text = `${call.getExpression().getText()}(${shown})`;
  return text.replace(/\s+/g, " ");
}
