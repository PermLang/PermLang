import Database from "better-sqlite3";
import { Pool } from "pg";
import postgres from "postgres";

const pool = new Pool();
const sqlite = new Database("app.db");
const sql = postgres("postgres://localhost/app");

// Literal SQL: the tables are read out of the query text.
/** @perm db.read(leads), db.read(teams), db.write(audit) */
export async function report(id: string) {
  await pool.query("SELECT l.name FROM leads l JOIN teams t ON t.id = l.team_id WHERE l.id = $1", [id]);
  sqlite.prepare("INSERT INTO audit (event) VALUES (?)").run("report");
  // postgres.js: substitutions are bound parameters, so the literal parts still name the tables.
  return sql`SELECT * FROM leads WHERE id = ${id}`;
}
