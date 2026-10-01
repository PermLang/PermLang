// Raw-SQL database clients: pg, mysql2, better-sqlite3, sqlite3, postgres (postgres.js),
// @neondatabase/serverless, @vercel/postgres. When the query is literal text, its
// tables are read out of it (`SELECT ... FROM leads` → db.read(leads)). SQL built
// from strings can touch any table, and needs bare db.read and db.write.
//
// Tagged templates (postgres.js's sql`...`) bind their substitutions as parameters,
// so the literal parts still name the tables. A template string passed to query()
// is concatenation, which is how SQL injection happens: it is unknown.

import { Node } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import type { Capability } from "../capability.js";
import { sqlTables } from "./sql-tables.js";
import { argumentsOf, literalString, unwrapExpression, type CallLike } from "./shared.js";

/** Methods whose first argument is SQL text, per package. */
const TEXT_METHODS: Record<string, readonly string[]> = {
  pg: ["query"],
  mysql2: ["query", "execute"],
  "better-sqlite3": ["prepare", "exec"],
  sqlite3: ["run", "all", "get", "each", "exec", "prepare"],
  postgres: ["unsafe"],
  "@neondatabase/serverless": ["query"],
  "@vercel/postgres": ["query"],
};

/** Packages whose tagged templates run SQL with bound parameters. */
const TAG_PACKAGES = new Set(["postgres", "@neondatabase/serverless", "@vercel/postgres"]);

/** Packages covered here, so they aren't reported as having no adapter. */
export const SQL_PACKAGES: readonly string[] = [...Object.keys(TEXT_METHODS)];

const unknown: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

/** `declaration` is the resolved signature of `call`. */
export function sqlCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  const pkg = packageOf(declaration);
  if (pkg === undefined) return [];
  const name = packageName(pkg);

  if (call && Node.isTaggedTemplateExpression(call) && TAG_PACKAGES.has(name)) {
    return fromSql(templateText(call.getTemplate()));
  }
  const method = memberName(declaration);
  if (!method || !TEXT_METHODS[name]?.includes(method)) return [];
  // Used as a value (no call), the SQL is unknown.
  return fromSql(call ? queryText(argumentsOf(call)[0]) : undefined);
}

function fromSql(sql: string | undefined): Capability[] {
  const tables = sql === undefined ? undefined : sqlTables(sql);
  if (!tables) return unknown;
  return [
    ...tables.read.map((t): Capability => ({ name: "db.read", arg: t })),
    ...tables.write.map((t): Capability => ({ name: "db.write", arg: t })),
  ];
}

/** The SQL of a query argument: literal text, or a `{ text }` / `{ sql }` config object with literal text. */
function queryText(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  const inner = unwrapExpression(arg);
  const direct = literalString(inner);
  if (direct !== undefined) return direct;
  if (Node.isObjectLiteralExpression(inner)) {
    for (const key of ["text", "sql"]) {
      const prop = inner.getProperty(key);
      if (prop && Node.isPropertyAssignment(prop)) return literalString(prop.getInitializer());
    }
  }
  return undefined;
}

/** A tagged template's literal parts, with each substitution as a bound parameter. */
function templateText(template: Node): string {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralValue();
  if (!Node.isTemplateExpression(template)) return "";
  return [template.getHead().getLiteralText(), ...template.getTemplateSpans().map((s, i) => `$${i + 1}${s.getLiteral().getLiteralText()}`)].join("");
}

function memberName(d: Node): string | undefined {
  return "getName" in d ? (d as { getName(): string | undefined }).getName() : undefined;
}
