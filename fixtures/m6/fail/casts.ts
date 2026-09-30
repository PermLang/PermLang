import { readFileSync } from "node:fs";

// Found in the pre-release review: a cast gives a literal type without a literal value.
/** @perm net(good.example), fs.read(data) */
export function casts(u: string, p: string) {
  void fetch(u as "https://good.example/"); // expect: error PERM001 net
  readFileSync(p as "data/x.json"); // expect: error PERM001 fs.read
  const aliased = u as "https://good.example/";
  return fetch(aliased); // expect: error PERM001 net
}
