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
    return [key === undefined ? { name: "db.read", dynamic: true } : { name: "db.read", arg: key }, ...relationReads(args[0])];
  }
  // Migrations run arbitrary DDL and DML from files.
  if (method === "migrate") return [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];
  return [];
}

const TABLE_FUNCTIONS = new Set(["pgTable", "mysqlTable", "sqliteTable", "singlestoreTable", "gelTable"]);

/**
 * A table argument's name, from its definition: pgTable("name", ...),
 * pgSchema("schema").table("name", ...), or alias(table, ...). Anything else,
 * including pgTableCreator prefixes and non-literal names, is dynamic: a guessed
 * name could be the wrong table.
 */
function table(arg: Node | undefined, depth = 0): { arg: string } | { dynamic: true } {
  if (!arg || depth > 5) return { dynamic: true };
  const node = unwrapExpression(arg);
  if (Node.isCallExpression(node)) return definition(node, depth);
  const nameNode = Node.isPropertyAccessExpression(node) ? node.getNameNode() : node;
  const symbol = nameNode.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (!declaration || !Node.isVariableDeclaration(declaration)) return { dynamic: true };
  if (declaration.getVariableStatement()?.getDeclarationKind() !== "const") return { dynamic: true };
  const init = declaration.getInitializer();
  const created = init && unwrapExpression(init);
  return created && Node.isCallExpression(created) ? definition(created, depth) : { dynamic: true };
}

function definition(created: Node & { getExpression(): Node; getArguments(): Node[] }, depth: number): { arg: string } | { dynamic: true } {
  const callee = unwrapExpression(created.getExpression());
  const [first, second] = created.getArguments();
  // pgTable("leads", ...)
  if (Node.isIdentifier(callee) && TABLE_FUNCTIONS.has(callee.getText()) && fromDrizzle(callee)) {
    const name = literalString(first);
    return name === undefined ? { dynamic: true } : { arg: name };
  }
  if (Node.isPropertyAccessExpression(callee)) {
    // pgSchema("private").table("secrets", ...)
    const owner = unwrapExpression(callee.getExpression());
    if (callee.getName() === "table" && Node.isCallExpression(owner) && /Schema$/.test(owner.getExpression().getText()) && fromDrizzle(callee.getNameNode())) {
      const schema = literalString(owner.getArguments()[0]);
      const name = literalString(first);
      return schema === undefined || name === undefined ? { dynamic: true } : { arg: `${schema}.${name}` };
    }
  }
  // alias(leads, "l") reads leads.
  if (Node.isIdentifier(callee) && callee.getText() === "alias" && fromDrizzle(callee) && second !== undefined) {
    return table(first, depth + 1);
  }
  return { dynamic: true };
}

/** Whether a name resolves into drizzle-orm itself. */
function fromDrizzle(name: Node): boolean {
  const symbol = name.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  const pkg = declaration && packageOf(declaration);
  return pkg !== undefined && packageName(pkg) === "drizzle-orm";
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

/**
 * Relations loaded with { with: { posts: { with: { comments: true } } } }, which are
 * read too, at any depth. Options that aren't written out (a variable, a spread)
 * could load any relation, so they read an unknown table.
 */
function relationReads(config: Node | undefined): Capability[] {
  if (!config) return [];
  const object = unwrapExpression(config);
  if (!Node.isObjectLiteralExpression(object)) return [{ name: "db.read", dynamic: true }];
  if (object.getProperties().some((p) => Node.isSpreadAssignment(p))) return [{ name: "db.read", dynamic: true }];
  const withProp = object.getProperty("with");
  if (!withProp) return [];
  if (!Node.isPropertyAssignment(withProp)) return [{ name: "db.read", dynamic: true }];
  const value = withProp.getInitializer() && unwrapExpression(withProp.getInitializer()!);
  if (!value || !Node.isObjectLiteralExpression(value)) return [{ name: "db.read", dynamic: true }];
  const out: Capability[] = [];
  for (const p of value.getProperties()) {
    if (!Node.isPropertyAssignment(p) && !Node.isShorthandPropertyAssignment(p)) {
      out.push({ name: "db.read", dynamic: true });
      continue;
    }
    out.push({ name: "db.read", arg: p.getName() });
    const nested = Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
    const nestedValue = nested && unwrapExpression(nested);
    if (nestedValue && Node.isObjectLiteralExpression(nestedValue)) out.push(...relationReads(nestedValue));
    else if (nestedValue && !(Node.isTrueLiteral(nestedValue) || Node.isFalseLiteral(nestedValue))) out.push({ name: "db.read", dynamic: true });
  }
  return out;
}
