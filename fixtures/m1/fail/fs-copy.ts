import { copyFileSync } from "node:fs";

/** @perm fs.read(./data) */
export function backup() {
  copyFileSync("./data/db.sqlite", "./public/db.sqlite"); // expect: error PERM001 fs.write(./public/db.sqlite)
}
