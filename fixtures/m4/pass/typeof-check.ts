// Checking whether fetch exists doesn't use it.
/** @perm env(MODE) */
export function hasFetch() {
  return typeof fetch === "function";
}
