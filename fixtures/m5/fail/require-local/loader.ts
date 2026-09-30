// require() of a local file runs its top-level code, like import.
/** @perm env(MODE) */
export function boot() {
  return require("./setup"); // expect: error PERM001 net(setup.example)
}
