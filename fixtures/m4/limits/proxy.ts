// limit: a Proxy trap can return a capability function for any property name.
const net = new Proxy({} as Record<string, unknown>, { get: () => fetch });

/** @perm env(MODE) */
export function call() {
  return (net.anything as (url: string) => unknown)("https://proxy.example/");
}
