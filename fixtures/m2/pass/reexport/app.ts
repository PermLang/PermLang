import { loadConfig } from "./index.js";

/** @perm fs.read(./config) */
export function start() {
  return loadConfig();
}
