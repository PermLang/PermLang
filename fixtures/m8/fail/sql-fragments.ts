import postgres, { type Helper } from "postgres";

const sql = postgres("postgres://localhost/app");

// Found in the second review: a substitution that is SQL itself, not a value.
/** @perm db.read(leads) */
export async function viaFragments(table: string, id: string) {
  await sql`DELETE FROM ${sql(table)}`; // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql`SELECT * FROM ${sql("secrets")}`; // expect: error PERM001 db.read expect: error PERM001 db.write
  // A fragment runs if it is awaited, and its text is not a whole statement: unknown.
  const where = sql`WHERE id = ${id}`; // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql`SELECT * FROM leads ${where}`; // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql`SELECT * FROM leads WHERE x = ${sql.unsafe(table)}`; // expect: error PERM001 db.read expect: error PERM001 db.write
}

// A fragment made elsewhere and passed in, where a value would be fine: only its
// type says it is SQL, and it could be "1 UNION SELECT * FROM secrets".
/** @perm db.read(leads) */
export async function viaParameter(fragment: Helper) {
  await sql`SELECT * FROM leads WHERE id = ${fragment}`; // expect: error PERM001 db.read expect: error PERM001 db.write
}

// Plain values are bound parameters, so the literal parts still name the tables.
/** @perm db.read(leads) */
export async function viaValues(id: string, limit: number) {
  return sql`SELECT * FROM leads WHERE id = ${id} LIMIT ${limit}`;
}
