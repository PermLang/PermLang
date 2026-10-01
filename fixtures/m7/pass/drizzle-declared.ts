import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";

// The table name comes from its pgTable definition, not the variable name.
const leads = pgTable("leads", { id: text("id"), teamId: text("team_id") });
const teams = pgTable("teams", { id: text("id") });

const db = drizzle("postgres://localhost/app");

/** @perm db.read(leads), db.read(teams), db.write(leads) */
export async function assign(id: string, teamId: string) {
  await db.select().from(leads).leftJoin(teams, eq(leads.teamId, teams.id));
  await db.update(leads).set({ teamId }).where(eq(leads.id, id));
  return db.query.leads!.findFirst({ where: eq(leads.id, id) });
}
