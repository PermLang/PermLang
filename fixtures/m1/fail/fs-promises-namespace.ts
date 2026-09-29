import * as fs from "node:fs";

/** @perm fs.read(./data) */
export async function readSecrets() {
  return fs.promises.readFile("/etc/passwd", "utf8"); // expect: error PERM001 fs.read(/etc/passwd)
}
