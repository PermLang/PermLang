const api = {
  ping: () => fetch("https://ping.example/"),
};

/** @perm net(ping.example) */
export function ping() {
  return api["ping"]();
}
