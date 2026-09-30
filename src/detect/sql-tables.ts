// Table names read out of a literal SQL statement, for raw-SQL database clients.
//
// This is deliberately conservative: it recognizes the tables of one ordinary
// statement (SELECT, INSERT, UPDATE, DELETE, and table DDL). Anything it can't be
// sure of (several statements, procedures, dynamic SQL) is reported as unknown,
// and unknown SQL needs bare db.read and db.write.

export interface SqlTables {
  read: string[];
  write: string[];
}

const IDENT_PART = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const IDENT = `${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})*`;

const STATEMENTS = /^(select|with|insert|update|delete|replace|merge|create|drop|alter|truncate|values)\b/i;

const WRITES = [
  /\binsert\s+(?:or\s+\w+\s+)?into\s+/gi,
  /\breplace\s+into\s+/gi,
  /\bmerge\s+into\s+/gi,
  /\bupdate\s+(?:only\s+)?/gi,
  /\bdelete\s+from\s+(?:only\s+)?/gi,
  /\btruncate\s+(?:table\s+)?/gi,
  /\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?/gi,
  /\bdrop\s+table\s+(?:if\s+exists\s+)?/gi,
  /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/gi,
];

// The name must end at a word boundary before the "not a function call" check, or the
// engine backtracks to a shorter match: `generate_series(` would match as `generate_serie`.
const READ = new RegExp(`\\b(?:from|join)\\s+(?:only\\s+|lateral\\s+)?(${IDENT})(?![\\w$."\\x60\\]])(?!\\s*\\()`, "gi");

/** Undefined when the statement can't be analyzed with confidence. */
export function sqlTables(sql: string): SqlTables | undefined {
  const text = stripCommentsAndStrings(sql);
  if (text === undefined) return undefined;
  const statements = text.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length !== 1) return statements.length === 0 ? { read: [], write: [] } : undefined;
  const statement = statements[0]!;
  if (!STATEMENTS.test(statement)) return undefined;

  const ctes = new Set(
    [...statement.matchAll(new RegExp(`(?:\\bwith\\s+(?:recursive\\s+)?|,\\s*)(${IDENT})\\s+as\\s*\\(`, "gi"))].map((m) => normalize(m[1]!)),
  );

  const write: string[] = [];
  const writeStarts = new Set<number>();
  for (const pattern of WRITES) {
    for (const m of statement.matchAll(pattern)) {
      const rest = statement.slice(m.index + m[0].length);
      const name = new RegExp(`^(${IDENT})`).exec(rest)?.[1];
      if (name) {
        write.push(normalize(name));
        writeStarts.add(m.index + m[0].length);
      }
    }
  }

  const read: string[] = [];
  for (const m of statement.matchAll(READ)) {
    const before = statement.slice(0, m.index);
    const nameStart = m.index + m[0].length - m[1]!.length;
    if (writeStarts.has(nameStart)) continue; // `DELETE FROM t` is a write
    if (/\bis\s+(?:not\s+)?distinct\s*$/i.test(before)) continue; // `a IS DISTINCT FROM b`
    if (/\b(?:extract|substring|trim|overlay|position)\s*\([^()]*$/i.test(before)) continue; // EXTRACT(YEAR FROM d)
    const name = normalize(m[1]!);
    if (!ctes.has(name)) read.push(name);
  }

  return { read: unique(read), write: unique(write) };
}

/** Removes comments and string literals, keeping quoted identifiers. Undefined for dollar-quoted bodies. */
function stripCommentsAndStrings(sql: string): string | undefined {
  if (/\$\w*\$/.test(sql)) return undefined; // DO $$ ... $$: a procedural body
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += " ";
    } else if (c === "'") {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      out += "''";
    } else {
      out += c;
    }
  }
  return out;
}

function normalize(name: string): string {
  return name
    .split(/\s*\.\s*/)
    .map((part) => part.replace(/^["`[]|["`\]]$/g, ""))
    .join(".");
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}
