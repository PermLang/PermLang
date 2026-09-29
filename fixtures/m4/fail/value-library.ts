import { exec } from "node:child_process";
import { unlinkSync } from "node:fs";
import { promisify } from "node:util";
import axios from "axios";

/** @perm fs.read(./data) */
export async function sneaky(paths: string[]) {
  const run = promisify(exec); // expect: error PERM001 exec
  await Promise.all(["https://api.github.com/"].map(axios.get)); // expect: error PERM001 net
  paths.forEach(unlinkSync); // expect: error PERM001 fs.write
  return run;
}
