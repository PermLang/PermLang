import { readFileSync } from "node:fs";

// A const string's value is known from its type, so its scope is exact.
const CONFIG = "./config/app.json";
const API = "https://api.github.com/zen";

/** @perm fs.read(./config), net(api.github.com) */
export async function load() {
  const config = readFileSync(CONFIG, "utf8");
  return { config, zen: await fetch(API) };
}
