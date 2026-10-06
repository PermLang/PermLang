import { createPool } from "mysql2/promise";

const myp = createPool("mysql://localhost/app");

interface Lead {
  name: string;
}

// Values mysql2 escapes as data: strings, numbers, dates, buffers, and arrays and records of them.
/** @perm db.read(leads), db.write(leads) */
export async function plain(id: string | number, when: Date, ids: readonly (string | number)[], data: Buffer, tags: Record<string, string | null>, maybe?: number) {
  await myp.query("SELECT * FROM leads WHERE id = ? AND created > ?", [id, when]);
  await myp.query("SELECT * FROM leads WHERE id IN (?)", [ids]);
  await myp.query("SELECT * FROM leads WHERE id = ?", [maybe ?? null]);
  await myp.query("INSERT INTO leads (a, b) VALUES ?", [[[1, "x"], [2, new Date()]]]);
  await myp.query("INSERT INTO leads SET ?", [{ name: String(id), data, created: when }]);
  await myp.query("UPDATE leads SET ? WHERE id = ?", [tags, id]);
  const row = { name: "x", score: 1 };
  await myp.query("INSERT INTO leads SET ?", [row]);
  await myp.query({ sql: "SELECT * FROM leads WHERE id = ?", values: [id] });
  await myp.query("SELECT * FROM leads WHERE note = '10:30' AND id = :id", { id });
  // With no values, nothing is pasted into the text.
  await myp.query("SELECT * FROM leads WHERE note = 'why?'");
}

/** @perm db.read(leads) */
export async function narrow<T extends string>(value: T) {
  await myp.query("SELECT * FROM leads WHERE id = ?", [value]);
}

// execute() binds values on the server, which never calls toSqlString(); a prepared
// statement runs the SQL prepare() read.
/** @perm db.read(leads), db.write(leads) */
export async function bound(lead: Lead, anything: unknown) {
  await myp.execute("INSERT INTO leads SET name = ?", [lead.name]);
  await myp.execute("SELECT * FROM leads WHERE id = ?", [anything]);
  const statement = await myp.prepare("SELECT * FROM leads WHERE id = ?");
  await statement.execute([anything]);
  await statement.close();
}
