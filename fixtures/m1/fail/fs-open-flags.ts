import { openSync } from "node:fs";

/** @perm fs.read(./data) */
export function truncate() {
  return openSync("./data/app.db", "w"); // expect: error PERM001 fs.write(./data/app.db)
}
