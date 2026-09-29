import https from "node:https";

/** @perm net(api.github.com) */
export function zen() {
  https.get("https://api.github.com/zen", (res) => res.resume());
  https.request({ hostname: "api.github.com", path: "/octocat" }).end();
}
