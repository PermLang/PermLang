import axios from "axios";

// const aliases of capability functions are fine: calls through them resolve by signature.
/** @perm net(api.github.com) */
export async function github() {
  const f = fetch;
  const get = axios.get;
  await f("https://api.github.com/zen");
  return get("https://api.github.com/octocat");
}
