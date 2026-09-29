import fs from "fs";

/** @perm fs.read(./tmp) */
export function cleanup() {
  fs.unlinkSync("./tmp/session.lock"); // expect: error PERM001 fs.write(./tmp/session.lock)
}
