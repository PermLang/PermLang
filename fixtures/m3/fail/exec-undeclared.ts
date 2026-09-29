import { exec, spawn } from "node:child_process";
import * as cp from "child_process";

/** @perm fs.read(./scripts) */
export function run() {
  exec("rm -rf ./tmp"); // expect: error PERM001 exec
  spawn("curl", ["https://example.com"]); // expect: error PERM001 exec
  cp.execFileSync("ls"); // expect: error PERM001 exec
}
