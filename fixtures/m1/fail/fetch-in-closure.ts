// Calls inside anonymous callbacks count toward the enclosing named function.
/** @perm fs.read(./urls) */
export async function crawl(urls: string[]) {
  return Promise.all(urls.map((u) => fetch(u))); // expect: error PERM001 net
}
