// A local function named `fetch` is not the global network fetch.
function fetch(key: string): string {
  return key.toUpperCase();
}

export function lookup(key: string) {
  return fetch(key);
}
