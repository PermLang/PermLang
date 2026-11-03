import { lstatSync, statSync, statSync as inspect } from "node:fs";
import * as fs from "node:fs";

// @types/node before 25 declares statSync and lstatSync as constants of one shared
// type (`const statSync: StatSyncFn`), so a call resolves to that type's call signature.
/** @perm fs.read(./data) */
export function probe(name: string) {
  const size = statSync("./config.json").size; // expect: error PERM001 fs.read(./config.json)
  const link = lstatSync("/etc/passwd").isSymbolicLink(); // expect: error PERM001 fs.read(/etc/passwd)
  const quiet = fs.statSync("/etc/shadow", { throwIfNoEntry: false }); // expect: error PERM001 fs.read(/etc/shadow)
  const renamed = inspect("/root/.ssh"); // expect: error PERM001 fs.read(/root/.ssh)
  const found = [`/home/${name}`].map(fs.lstatSync); // expect: error PERM001 fs.read
  return { size, link, quiet, renamed, found };
}

/** @perm fs.read(./data) */
export function aliases(follow: boolean) {
  const { statSync: st } = fs;
  const look = lstatSync;
  st("/etc/hosts"); // expect: error PERM001 fs.read(/etc/hosts)
  look("/etc/group"); // expect: error PERM001 fs.read(/etc/group)
  fs["lstatSync"]("/etc/sudoers"); // expect: error PERM001 fs.read(/etc/sudoers)
  // Both are also used as values, so they could be called with any path.
  (follow ? statSync : lstatSync)("/etc/fstab"); // expect: error PERM001 fs.read(/etc/fstab) expect: error PERM001 fs.read
  statSync.call(undefined, "/etc/crontab"); // expect: error PERM001 fs.read(/etc/crontab)
}

/** @perm fs.read(./data) */
export function exists(file: string): boolean {
  try {
    statSync(`/var/${file}`); // expect: error PERM001 fs.read
    return true;
  } catch {
    return false;
  }
}
