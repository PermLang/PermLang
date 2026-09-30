// Found in the pre-release review: `process["env"]` wasn't recognized.
/** @perm env(PORT) */
export function bracket() {
  return process["env"].SECRET; // expect: error PERM001 env(SECRET)
}
