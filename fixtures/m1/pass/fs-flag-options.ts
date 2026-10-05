import fs, { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";

declare const encoded: { encoding: BufferEncoding };

// Options that don't open the file for writing, and functions that only resolve a path.
/** @perm fs.read(./data) */
export async function reads() {
  readFileSync("./data/a.json", "utf8");
  readFileSync("./data/b.json", { encoding: "utf8", flag: "r" });
  readFileSync("./data/c.json", encoded);
  createReadStream("./data/d.log", { start: 10 });
  await readFile("./data/e.json", { encoding: "utf8" });
  realpathSync.native("./data/f");
  fs.realpath.native("./data/g", () => {});
  await realpath("./data/h");
  fs.realpathSync("./data/i");
}

// Writing to a descriptor such as stdout is not a file write.
/** @perm fs.read(./data) */
export function stdout() {
  new fs.Utf8Stream({ fd: 1 });
}
