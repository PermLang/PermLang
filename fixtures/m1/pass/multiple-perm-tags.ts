import { readFileSync } from "node:fs";

/**
 * @perm net(api.github.com)
 * @perm fs.read(./cache)
 */
export async function syncRepo() {
  const cached = readFileSync("./cache/repo.json", "utf8");
  const res = await fetch("https://api.github.com/repos/permlang/permlang");
  return { cached, fresh: await res.json() };
}
