// @perm-unsafe silences one function's own checks, not its callers'.
/** @perm-unsafe reason:"wraps a legacy client" */
function legacy(url: string) {
  return fetch(url);
}

/** @perm env(MODE) */
export function caller() {
  return legacy("https://legacy.example/"); // expect: error PERM001 net
}
