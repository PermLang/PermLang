// Prisma, the first database client with built-in support (design doc open
// question 2). Prisma generates one `<Model>Delegate` interface per model; the
// table in db.read/db.write is the model's accessor name, e.g. `prisma.lead`.
//
// A client built with `$extends(...)` (read replicas, soft deletes, logging) types
// every model through generic runtime types instead, so the declaration doesn't
// name the model. Then the model is taken from the call site: `client.user.findMany`.

import { Node } from "ts-morph";
import type { Capability } from "../capability.js";
import { containerName, unwrapExpression, type CallLike } from "./shared.js";

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

const raw: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

/** `declaration` is the resolved signature of `call` (absent when the function is used as a value). */
export function prismaCapabilities(declaration: Node | undefined, call?: CallLike): Capability[] {
  if (!declaration || !/prisma/i.test(declaration.getSourceFile().getFilePath())) return [];
  const method = memberName(declaration) ?? calledName(call);
  if (!method) return [];
  const container = containerName(declaration);

  const model = /^(\w+)Delegate$/.exec(container ?? "")?.[1];
  if (model) return forModel(method, model[0]!.toLowerCase() + model.slice(1));
  if (RAW.test(method)) return raw;

  // An extended client: only the call site names the model.
  if (!READS.has(method) && !WRITES.has(method)) return [];
  return forModel(method, modelAtCallSite(call));
}

function forModel(method: string, table: string | undefined): Capability[] {
  const cap = (name: string): Capability => (table === undefined ? { name, dynamic: true } : { name, arg: table });
  if (READS.has(method)) return [cap("db.read")];
  if (WRITES.has(method)) return [cap("db.write")];
  // Anything else on a delegate (findRaw, aggregateRaw, ...) may do either.
  return [cap("db.read"), cap("db.write")];
}

function memberName(d: Node): string | undefined {
  if (Node.isMethodSignature(d) || Node.isMethodDeclaration(d) || Node.isPropertySignature(d)) return d.getName();
  return undefined;
}

/** `findMany` in `client.user.findMany(...)` or `` client.$queryRaw`...` ``. */
function calledName(call: CallLike | undefined): string | undefined {
  if (!call) return undefined;
  const callee = unwrapExpression(Node.isTaggedTemplateExpression(call) ? call.getTag() : call.getExpression());
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
}

/** `user` in `client.user.findMany(...)`; undefined when the model is reached another way. */
function modelAtCallSite(call: CallLike | undefined): string | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const object = unwrapExpression(callee.getExpression());
  return Node.isPropertyAccessExpression(object) ? object.getName() : undefined;
}
