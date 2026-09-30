// Drizzle ORM. The table in db.read/db.write is the name given to pgTable,
// mysqlTable, or sqliteTable: `pgTable("audit_log", ...)` is `audit_log`, whatever
// the variable is called.
//
//   db.select().from(t), .leftJoin(t, ...)      db.read(t)
//   db.insert(t), db.update(t), db.delete(t)    db.write(t)
//   db.query.<key>.findMany / findFirst          db.read(<key>), plus each `with` relation
//   db.execute / run / all / get / values(sql)   raw SQL: bare db.read and db.write

import { Node } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import type { Capability } from "../capability.js";
import { argumentsOf, containerName, literalString, resolveAlias, unwrapExpression, type CallLike } from "./shared.js";

const WRITES = new Set(["insert", "update", "delete"]);
const RAW = new Set(["execute", "run", "all", "get", "values"]);
const JOIN = /^(from|(left|right|inner|full|cross)Join(Lateral)?)$/;

export function drizzleCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  const pkg = packageOf(declaration);
  if (pkg === undefined || packageName(pkg) !== "drizzle-orm") return [];
  // Real drizzle declares joins as function-typed properties (`leftJoin: PgSelectJoinFn`),
  // whose signatures have no name; the call site names them.
  const method = ("getName" in declaration ? (declaration as { getName(): string | undefined }).getName() : undefined) ?? calledName(call);
  if (!method) return [];
  const container = containerName(declaration) ?? "";
  const args = call ? argumentsOf(call) : [];
  const isDatabase = /Database$/.test(container);

  if (isDatabase && WRITES.has(method)) return [{ name: "db.write", ...table(args[0]) }];
  if (isDatabase && RAW.has(method)) return [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];
  if (isDatabase && method === "$count") return [{ name: "db.read", ...table(args[0]) }];
  if (JOIN.test(method)) return [{ name: "db.read", ...table(args[0]) }];
  if (container === "RelationalQueryBuilder" && (method === "findMany" || method === "findFirst")) {
    const key = relationalKey(call);
    return [
      key === undefined ? { name: "db.read", dynamic: true } : { name: "db.read", arg: key },
      ...withRelations(args[0]).map((r): Capability => ({ name: "db.read", arg: r })),
    ];
  }
  return [];
}

/** A table argument's name, from its pgTable/mysqlTable/sqliteTable definition. */
function table(arg: Node | undefined): { arg: string } | { dynamic: true } {
  if (!arg) return { dynamic: true };
  const node = unwrapExpression(arg);
  const nameNode = Node.isPropertyAccessExpression(node) ? node.getNameNode() : node;
  const symbol = nameNode.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (declaration && Node.isVariableDeclaration(declaration)) {
    const init = declaration.getInitializer();
    const created = init && unwrapExpression(init);
    if (created && Node.isCallExpression(created) && /Table$/.test(created.getExpression().getText())) {
      const name = literalString(created.getArguments()[0]);
      if (name !== undefined) return { arg: name };
    }
    return { arg: declaration.getName() };
  }
  return { dynamic: true };
}

function calledName(call: CallLike | undefined): string | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
}

/** `leads` in `db.query.leads.findMany()`: the schema key. */
function relationalKey(call: CallLike | undefined): string | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const holder = unwrapExpression(callee.getExpression());
  if (Node.isPropertyAccessExpression(holder)) return holder.getName();
  if (Node.isElementAccessExpression(holder)) return literalString(holder.getArgumentExpression());
  return undefined;
}

/** Relations loaded with `{ with: { posts: true } }`, which are read too. */
function withRelations(config: Node | undefined): string[] {
  const object = config && unwrapExpression(config);
  if (!object || !Node.isObjectLiteralExpression(object)) return [];
  const withProp = object.getProperty("with");
  const value = withProp && Node.isPropertyAssignment(withProp) ? withProp.getInitializer() : undefined;
  if (!value || !Node.isObjectLiteralExpression(value)) return [];
  return value.getProperties().flatMap((p) => ("getName" in p ? [(p as { getName(): string }).getName()] : []));
}
