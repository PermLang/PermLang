import { statSync, readdirSync } from "node:fs";

// Methods on what fs returns (Stats, Dirent) are not new file access.
/** @perm fs.read(./data) */
export function describe() {
  const isDir = statSync("./data").isDirectory();
  const names = readdirSync("./data", { withFileTypes: true }).map((d) => d.isFile());
  return { isDir, names };
}
