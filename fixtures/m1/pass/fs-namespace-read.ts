import * as fs from "node:fs";

/** @perm fs.read(./config) */
export function loadConfig() {
  return JSON.parse(fs.readFileSync("./config/app.json", "utf8"));
}
