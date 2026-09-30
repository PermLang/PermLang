import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";

const leads = pgTable("leads", { id: text("id") });
const auditLog = pgTable("audit_log", { event: text("event") });
const secrets = pgTable("api_secrets", { key: text("key") });

const db = drizzle("postgres://localhost/app");

/** @perm db.read(leads) */
export async function sneaky(id: string) {
  await db.select().from(secrets); // expect: error PERM001 db.read(api_secrets)
  await db.insert(auditLog).values({ event: "x" }); // expect: error PERM001 db.write(audit_log)
  await db.delete(leads).where(eq(leads.id, id)); // expect: error PERM001 db.write(leads)
  await db.query.teams!.findMany(); // expect: error PERM001 db.read(teams)
  await db.execute(sql`DROP TABLE leads`); // expect: error PERM001 db.read expect: error PERM001 db.write
}
