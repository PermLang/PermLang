/** @perm env(MODE) */
export async function load(name: string) {
  return import(name); // expect: error PERM004 unverifiable
}

// A literal specifier runs that module's top-level code.
/** @perm env(MODE) */
export async function boot() {
  return import("./boot.js"); // expect: error PERM001 net(boot.example)
}
