// Found while testing the packed CLI in a project without @types/node: with no types,
// nothing called from these modules can be checked, so they must not pass silently.
import { exec } from "node:child_process-missing-types";
import { thing } from "no-such-package";

export function run() {
  exec("ls");
  return thing();
}
