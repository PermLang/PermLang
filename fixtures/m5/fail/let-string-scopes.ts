import { readFileSync } from "node:fs";

// A `let` can be reassigned, so its type is `string` and its value is unknown.
let config = "./config/app.json";

/** @perm fs.read(./config) */
export function load() {
  config = config.replace("app", "../secrets");
  return readFileSync(config, "utf8"); // expect: error PERM001 fs.read
}
