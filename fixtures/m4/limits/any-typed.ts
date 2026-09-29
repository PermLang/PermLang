// limit: calls on values typed `any` can't be resolved. Here a dynamic import of a
// Node built-in is cast to `any`, and the exec call on it is invisible.
/** @perm env(MODE) */
export async function run() {
  const cp: any = await import("node:child_process");
  cp.exec("ls");
}
