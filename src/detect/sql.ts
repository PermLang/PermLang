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
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { sqlTables } from "./sql-tables.js";
import { argumentsOf, containerName, literalString, resolvedDeclaration, unwrapExpression, type CallLike } from "./shared.js";

/** Methods whose first argument is SQL text, per package. */
const TEXT_METHODS: Record<string, readonly string[]> = {
  pg: ["query"],
  mysql2: ["query", "execute", "prepare"],
  "better-sqlite3": ["prepare", "exec"],
  sqlite3: ["run", "all", "get", "each", "exec", "prepare"],
  postgres: ["unsafe"],
  "@neondatabase/serverless": ["query"],
  "@vercel/postgres": ["query"],
};

// Methods that touch no table: connection lifecycle, transactions (whose queries are
// checked where they're written), statement handles, and pure helpers. Every other
// method on these packages is unknown database access, so new or unusual APIs
// (COPY streams, pragmas, large objects) never pass silently.
const SAFE_METHODS: Record<string, readonly string[]> = {
  pg: ["connect", "end", "release", "on", "once", "off", "removeListener", "removeAllListeners", "pauseDrain", "resumeDrain", "getTransactionStatus", "escapeLiteral", "escapeIdentifier"],
  mysql2: ["createConnection", "createPool", "createPoolCluster", "connect", "end", "destroy", "release", "releaseConnection", "getConnection", "beginTransaction", "commit", "rollback", "ping", "pause", "resume", "escape", "escapeId", "format", "on", "once", "unprepare", "close", "reset"],
  "better-sqlite3": ["close", "transaction", "defaultSafeIntegers", "function", "aggregate", "table", "run", "get", "all", "iterate", "pluck", "expand", "raw", "columns", "bind", "safeIntegers"],
  sqlite3: ["verbose", "close", "serialize", "parallelize", "configure", "interrupt", "on", "once", "bind", "reset", "finalize"],
  postgres: ["postgres", "begin", "end", "reserve", "release", "json", "array", "typed", "savepoint"],
  "@neondatabase/serverless": ["neon", "neonConfig", "transaction", "connect", "end", "release", "on"],
  "@vercel/postgres": ["createPool", "createClient", "connect", "end", "release", "on"],
};

// Methods that do more than query a table.
const SPECIAL_METHODS: Record<string, Record<string, readonly Capability[]>> = {
  "better-sqlite3": {
    loadExtension: [{ name: UNVERIFIABLE }],
    backup: [{ name: "fs.write", dynamic: true }, { name: "db.read", dynamic: true }],
    serialize: [{ name: "db.read", dynamic: true }],
  },
  sqlite3: { loadExtension: [{ name: UNVERIFIABLE }] },
  postgres: { file: [{ name: "fs.read", dynamic: true }, { name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }] },
};

// sqlite3's Statement has run/all/get too, without SQL text; only Database's take SQL.
const TEXT_CONTAINERS: Record<string, string> = { sqlite3: "Database" };

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
  if (!(name in TEXT_METHODS)) return [];

  if (call && Node.isTaggedTemplateExpression(call) && TAG_PACKAGES.has(name)) {
    return fromSql(templateText(call.getTemplate()));
  }
  // A call signature (postgres.js `sql(value)`, a helper) or a constructor touches no table.
  const method = memberName(declaration);
  if (!method) return [];
  const special = SPECIAL_METHODS[name]?.[method];
  if (special) return [...special];
  const textContainer = TEXT_CONTAINERS[name];
  if (TEXT_METHODS[name]!.includes(method) && (!textContainer || containerName(declaration) === textContainer)) {
    // Used as a value (no call), the SQL is unknown.
    return fromSql(call ? queryText(argumentsOf(call)[0]) : undefined);
  }
  if (SAFE_METHODS[name]?.includes(method) || (textContainer && containerName(declaration) !== textContainer && TEXT_METHODS[name]!.includes(method))) {
    return [];
  }
  return unknown;
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

/**
 * A tagged template's literal parts, with each substitution as a bound parameter.
 * Undefined when a substitution is SQL itself rather than a value: postgres.js
 * `${sql(name)}` (an identifier), a nested sql`...` fragment, or `${sql.unsafe(x)}`,
 * any of which can name a table or inject a statement.
 */
function templateText(template: Node): string | undefined {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralValue();
  if (!Node.isTemplateExpression(template)) return undefined;
  const spans = template.getTemplateSpans();
  if (spans.some((s) => isSqlFragment(s.getExpression()))) return undefined;
  return [template.getHead().getLiteralText(), ...spans.map((s, i) => `$${i + 1}${s.getLiteral().getLiteralText()}`)].join("");
}

/** An expression whose value comes from a SQL package: a fragment, identifier, or helper. */
function isSqlFragment(expression: Node): boolean {
  const inner = unwrapExpression(expression);
  if (Node.isCallExpression(inner) || Node.isTaggedTemplateExpression(inner)) {
    const declaration = resolvedDeclaration(inner);
    const pkg = declaration && packageOf(declaration);
    if (pkg && TAG_PACKAGES.has(packageName(pkg))) return true;
  }
  const type = inner.getType();
  return [type.getSymbol(), type.getAliasSymbol()].some((symbol) =>
    symbol?.getDeclarations().some((d) => {
      const pkg = packageOf(d);
      return pkg !== undefined && TAG_PACKAGES.has(packageName(pkg));
    }),
  );
}

function memberName(d: Node): string | undefined {
  return "getName" in d ? (d as { getName(): string | undefined }).getName() : undefined;
}
