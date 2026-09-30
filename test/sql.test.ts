// Reading table names out of literal SQL, for raw-SQL database clients.
import { describe, expect, it } from "vitest";
import { sqlTables } from "../src/detect/sql-tables.js";

describe("sqlTables", () => {
  it.each([
    ["SELECT * FROM leads WHERE id = $1", { read: ["leads"], write: [] }],
    ["select l.name from leads l join teams t on t.id = l.team_id", { read: ["leads", "teams"], write: [] }],
    ["INSERT INTO audit (event) VALUES ($1)", { read: [], write: ["audit"] }],
    ["UPDATE leads SET name = $1 FROM teams WHERE teams.id = leads.team_id", { read: ["teams"], write: ["leads"] }],
    ["DELETE FROM sessions WHERE expires < now()", { read: [], write: ["sessions"] }],
    ['SELECT * FROM "public"."users"', { read: ["public.users"], write: [] }],
    ["SELECT * FROM `orders` LEFT JOIN `items` ON 1=1", { read: ["orders", "items"], write: [] }],
    ["WITH recent AS (SELECT * FROM events) SELECT * FROM recent", { read: ["events"], write: [] }],
    ["SELECT * FROM generate_series(1, 10)", { read: [], write: [] }],
    ["SELECT * FROM (SELECT id FROM leads) sub", { read: ["leads"], write: [] }],
    ["-- FROM secrets\nSELECT 1 /* FROM hidden */", { read: [], write: [] }],
    ["SELECT 'FROM fake' AS x FROM real_table", { read: ["real_table"], write: [] }],
    ["INSERT OR REPLACE INTO cache (k, v) VALUES (?, ?)", { read: [], write: ["cache"] }],
    ["CREATE TABLE IF NOT EXISTS logs (id int)", { read: [], write: ["logs"] }],
    ["TRUNCATE TABLE staging", { read: [], write: ["staging"] }],
  ])("%s", (sql, expected) => {
    expect(sqlTables(sql)).toEqual(expected);
  });

  it.each([
    "CALL refresh_all()",
    "DO $$ BEGIN PERFORM 1; END $$",
    "EXECUTE my_plan",
    "SELECT * FROM leads; DROP TABLE users",
  ])("can't be sure about %j, so it's unknown", (sql) => {
    expect(sqlTables(sql)).toBeUndefined();
  });
});
