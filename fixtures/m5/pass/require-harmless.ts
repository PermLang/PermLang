// Found in the Ghostfolio trial: require() with a fixed specifier is as resolvable as
// import. Only a capability-bearing module (child_process, fs, an adapter's package)
// makes it unverifiable, because the result is `any` and its calls can't be checked.

/** @perm env(MODE) */
export function loadData() {
  const countries = require("./countries.json");
  const search = require("fuse.js");
  return { countries, search };
}
