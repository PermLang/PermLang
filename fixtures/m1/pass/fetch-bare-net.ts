// Bare `net` allows any host, so a URL that can't be resolved statically is covered.
/** @perm net */
export async function ping(url: string) {
  return fetch(url);
}
