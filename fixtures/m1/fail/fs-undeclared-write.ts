import { readFileSync, writeFileSync } from "node:fs";

/** @perm fs.read(./data) */
export function transform() {
  const input = readFileSync("./data/in.json", "utf8");
  writeFileSync("./data/out.json", input.toUpperCase()); // expect: error PERM001 fs.write(./data/out.json)
}
