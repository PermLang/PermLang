import { readFileSync } from "node:fs";

/** @perm fs.read(./data) */
export function load(name: string) {
  // `name` could be "../secrets", so a template path is not assumed to stay under ./data.
  return readFileSync(`./data/${name}.json`, "utf8"); // expect: error PERM001 fs.read
}
