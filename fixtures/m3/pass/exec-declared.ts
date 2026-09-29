import { execSync } from "node:child_process";

/** @perm exec */
export function gitSha() {
  return execSync("git rev-parse HEAD").toString().trim();
}
