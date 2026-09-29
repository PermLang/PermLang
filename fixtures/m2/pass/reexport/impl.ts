import { readFileSync } from "node:fs";

/** @perm fs.read(./config) */
export function readConfig() {
  return readFileSync("./config/app.json", "utf8");
}
