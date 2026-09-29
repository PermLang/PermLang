import { readFileSync } from "node:fs";

/** @perm fs.read(./data) */
export function load() {
  return readFileSync("./database.json", "utf8"); // expect: error PERM001 fs.read(./database.json)
}

/** @perm fs.read(./data) */
export function traverse() {
  return readFileSync("./data/../secrets.json", "utf8"); // expect: error PERM001 fs.read(./data/../secrets.json)
}
