import { SQL, StringChunk, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";

const leads = pgTable("leads", { id: text("id") });
const db = drizzle("postgres://localhost/app");

// Found in the fourth review: SQL put together from drizzle's own pieces, without
// sql`...` or sql.raw(), wasn't read at all.
/** @perm db.read(leads) */
export async function pieces(text: string) {
  // A chunk of text is pasted in as it is: literal text is read, anything else is unknown.
  const chunk = new StringChunk("EXISTS (SELECT 1 FROM secrets)"); // expect: error PERM001 db.read(secrets)
  await db.select().from(leads).where(sql`${new StringChunk(["(SELECT max(id) ", "FROM vault)"])} > 0`); // expect: error PERM001 db.read(vault)
  new StringChunk(text); // expect: error PERM001 db.read expect: error PERM001 db.write
  // SQL made from a list of pieces could hold any of them.
  await db.select().from(leads).where(new SQL([chunk])); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(sql.fromList([chunk])); // expect: error PERM001 db.read expect: error PERM001 db.write
  // An object of the project's own with getSQL() is pasted in as whatever SQL that returns.
  const wrapper = { getSQL: () => new SQL([]) };
  await db.select().from(leads).where(sql`${wrapper}`); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(new Condition()); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select({ n: new Condition() }).from(leads); // expect: error PERM001 db.read expect: error PERM001 db.write
}

class Condition {
  getSQL() {
    return new SQL([]);
  }
}
