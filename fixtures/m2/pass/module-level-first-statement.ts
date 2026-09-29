/**
 * @module
 * @perm fs.read(./templates)
 */
export function renderWelcome() {
  // The module comment sits directly above this function; it still applies file-wide.
  return readFileSync("./templates/welcome.html", "utf8");
}

// Imports are hoisted, so this is legal (if unusual) placement.
import { readFileSync } from "node:fs";
