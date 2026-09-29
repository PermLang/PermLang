// Passing fetch as a value lets it run anywhere, with any URL.
/** @perm env(MODE) */
export function crawl(urls: string[]) {
  return urls.map(fetch); // expect: error PERM001 net
}

// A const alias is fine to create; calls through it still resolve to fetch.
/** @perm env(MODE) */
export function viaConst() {
  const f = fetch;
  return f("https://alias.example/"); // expect: error PERM001 net(alias.example)
}

// A reassignable alias can be pointed anywhere, so creating it counts as a use.
/** @perm env(MODE) */
export function viaLet() {
  let g: typeof fetch = fetch; // expect: error PERM001 net
  return g("https://let.example/"); // expect: error PERM001 net(let.example)
}
