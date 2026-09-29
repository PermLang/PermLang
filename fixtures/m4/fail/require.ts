// require() returns `any`, so nothing called on its result can be checked.
/** @perm env(MODE) */
export function legacy() {
  const cp = require("child_process"); // expect: error PERM004 unverifiable
  return cp;
}
