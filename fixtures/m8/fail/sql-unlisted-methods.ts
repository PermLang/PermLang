import Database from "better-sqlite3";
import { Pool } from "pg";
import postgres from "postgres";

const lite = new Database("app.db");
const sql = postgres("postgres://localhost/app");
const pool = new Pool();

// Found in the second review: methods outside the SQL-text list passed silently.
/** @perm db.read(leads) */
export async function sneaky() {
  lite.loadExtension("./evil.so"); // expect: error PERM004 unverifiable
  await lite.backup("/tmp/copy.db"); // expect: error PERM001 fs.write expect: error PERM001 db.read
  lite.pragma("writable_schema = ON"); // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql.file("./migrations/evil.sql"); // expect: error PERM001 fs.read expect: error PERM001 db.read expect: error PERM001 db.write
  const client = await pool.connect();
  client.copyFrom("COPY leads FROM STDIN"); // expect: error PERM001 db.read expect: error PERM001 db.write
  client.release();
}

// Lifecycle methods touch no table.
/** @perm db.read(leads) */
export async function shutdown() {
  await pool.query("SELECT * FROM leads");
  lite.close();
  await sql.end();
  await pool.end();
}
