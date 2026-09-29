// Node's fs and fs/promises, classified into reads and writes with literal paths.
// This stays custom code rather than an adapter manifest: open() depends on its
// flags, and copies read one path and write another.

import { Node } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString } from "./shared.js";

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/** The fs function a declaration is, or undefined. */
export function fsFunctionName(declaration: Node): string | undefined {
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return undefined;
  return isInFsModule(declaration) ? declaration.getName() : undefined;
}

/**
 * A function exported by an fs module itself. Members of the objects fs returns
 * (`Stats.isDirectory`, `FileHandle.read`, streams) are excluded: they act on
 * something already opened or read, where the access was checked.
 */
function isInFsModule(declaration: Node): boolean {
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

/** What calling fs function `fn` with `args` touches. No args (used as a value) makes every path dynamic. */
export function fsCapabilities(fn: string, args: readonly Node[]): Capability[] {
  const base = fn.replace(/Sync$/, "");
  const scoped = (name: string, i: number): Capability => {
    const path = literalString(args[i]);
    return path === undefined ? { name, dynamic: true } : { name, arg: path };
  };
  const read = (i: number) => scoped("fs.read", i);
  const write = (i: number) => scoped("fs.write", i);

  if (FD_ONLY.has(base)) return [];
  if (READS.has(base)) return [read(0)];
  if (COPIES.has(base)) return [read(0), write(1)];
  if (TWO_PATH_WRITES.has(base)) return [write(0), write(1)];
  if (base === "open") return openCapabilities(args, read(0), write(0));
  // Everything else (writeFile, mkdir, rm, unlink, chmod, and anything unrecognized)
  // is treated as a write, so an unknown fs function never passes silently.
  return [write(0)];
}

function openCapabilities(args: readonly Node[], read: Capability, write: Capability): Capability[] {
  // Used as a value, open() could be called with any flags.
  if (args.length === 0) return [read, write];
  const flags = args[1];
  if (!flags) return [read];
  const f = literalString(flags);
  if (f === undefined) return [read, write];
  const caps: Capability[] = [];
  if (f.includes("r") || f.includes("+")) caps.push(read);
  if (/[wax+]/.test(f)) caps.push(write);
  return caps.length > 0 ? caps : [read, write];
}
