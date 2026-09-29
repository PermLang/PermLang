// Prisma, the first database client with built-in support (design doc open
// question 2). Prisma generates one `<Model>Delegate` interface per model; the
// table in db.read/db.write is the model's accessor name, e.g. `prisma.lead`.

import { Node } from "ts-morph";
import type { Capability } from "../capability.js";
import { containerName } from "./shared.js";

const READS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "count", "aggregate", "groupBy",
]);
const WRITES = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany",
]);
// Raw queries can touch any table, and a "query" can still write (INSERT ... RETURNING).
const RAW = /^\$(queryRaw|executeRaw|runCommandRaw)/;

/** `declaration` is the resolved signature of a call. */
export function prismaCapabilities(declaration: Node | undefined): Capability[] {
  if (!declaration || !/prisma/i.test(declaration.getSourceFile().getFilePath())) return [];
  const method = memberName(declaration);
  const container = containerName(declaration);
  if (!method || !container) return [];

  const model = /^(\w+)Delegate$/.exec(container)?.[1];
  if (model) {
    const table = model[0]!.toLowerCase() + model.slice(1);
    if (READS.has(method)) return [{ name: "db.read", arg: table }];
    if (WRITES.has(method)) return [{ name: "db.write", arg: table }];
    // Anything else on a delegate (findRaw, aggregateRaw, ...) may do either.
    return [{ name: "db.read", arg: table }, { name: "db.write", arg: table }];
  }
  if (container === "PrismaClient" && RAW.test(method)) {
    return [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];
  }
  return [];
}

function memberName(d: Node): string | undefined {
  if (Node.isMethodSignature(d) || Node.isMethodDeclaration(d) || Node.isPropertySignature(d)) return d.getName();
  return undefined;
}
