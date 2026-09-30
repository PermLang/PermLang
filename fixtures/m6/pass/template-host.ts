// The host is known when the literal part fixes the whole authority.
/** @perm net(good.example) */
export function known(id: string) {
  void fetch(`https://good.example/items/${id}`);
  void fetch(`https://good.example:8443/items/${id}`);
  return fetch(`https://user@good.example/${id}`);
}
