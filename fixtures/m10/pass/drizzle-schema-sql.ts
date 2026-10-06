import { StringChunk, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";

// Runtime defaults that return values, not SQL, add nothing to an insert or update.
const leads = pgTable("leads", {
  id: text("id").$defaultFn(() => "generated"),
  touched: text("touched").$onUpdateFn(() => String(Date.now())),
  slug: text("slug").default(sql`gen_random_uuid()`),
});
const db = drizzle("postgres://localhost/app");

/** @perm db.read(leads), db.write(leads) */
export async function write() {
  await db.insert(leads).values({ id: "1" });
  await db.update(leads).set({ id: "2" }).where(sql`${leads.id} = ${"1"}`);
  // A chunk of literal text that names no table, a column's name, and drizzle's own SQL nested.
  return db.select().from(leads).where(sql`${new StringChunk("1 = 1")} AND ${leads.id.name} IS NOT NULL AND ${sql`true`}`);
}

// Properties of the project's own objects that share a schema property's name.
/** @perm db.read(leads) */
export function lookalikes(form: { value: string; where: string; default: number }) {
  const { value, where } = form;
  return db.select().from(leads).where(sql`${leads.id} = ${value} OR ${where} = ${form.default}`);
}
