function load(id: number): Promise<Response>;
function load(name: string): Promise<Response>;
function load(key: number | string) {
  return fetch(`https://store.example/items/${key}`);
}

/** @perm env(STORE) */
export function first() {
  return load(1); // expect: error PERM001 net(store.example)
}
