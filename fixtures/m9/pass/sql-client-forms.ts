import mysql from "mysql2";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";
import postgres from "postgres";

const sql = postgres("postgres://localhost/app");
const pool = new Pool();
const my = mysql.createPool("mysql://localhost/app");
const myp = createPool("mysql://localhost/app");

// Found in the third review: these were reported as touching any table.
/** @perm db.read(leads) */
export async function modifiers() {
  await sql`SELECT * FROM leads`.values();
  await sql`SELECT * FROM leads`.simple().execute();
  await sql`SELECT * FROM leads`.describe();
  for await (const rows of sql`SELECT * FROM leads`.cursor(100)) void rows;
  await my.promise().query("SELECT * FROM leads");
}

// Plain values, written-out config objects, and postgres.js helpers outside a query.
/** @perm db.read(leads) */
export async function plain(id: number) {
  await myp.query("SELECT * FROM leads WHERE id = ?", [id]);
  await myp.query({ sql: "SELECT * FROM leads WHERE id = ?", values: [id] });
  await pool.query({ text: "SELECT * FROM leads WHERE id = $1", values: [id] });
  return sql("leads");
}
