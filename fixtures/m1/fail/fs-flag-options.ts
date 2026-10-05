import fs, { createReadStream, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

declare const options: { encoding?: BufferEncoding; flag?: string };
declare const mode: string;

// Found in the 0.3 review: a read function's `flag` option can truncate or append to the file.
/** @perm fs.read(./data) */
export async function flags() {
  readFileSync("./data/a.json", { flag: "w" }); // expect: error PERM001 fs.write(./data/a.json)
  readFileSync("./data/b.json", { encoding: "utf8", flag: "a+" }); // expect: error PERM001 fs.write(./data/b.json)
  createReadStream("./data/c.log", { flags: "w" }); // expect: error PERM001 fs.write(./data/c.log)
  await readFile("./data/d.json", { flag: "r+" }); // expect: error PERM001 fs.write(./data/d.json)
  fs.readFileSync("./data/e.json", options); // expect: error PERM001 fs.write(./data/e.json)
  fs.readFileSync("./data/f.json", { flag: mode }); // expect: error PERM001 fs.write(./data/f.json)
  fs.readFileSync("./data/g.json", { ...options, encoding: "utf8" }); // expect: error PERM001 fs.write(./data/g.json)
}

// Streams and descriptors that write without a write function.
/** @perm fs.read(./data) */
export function streams(fd: number) {
  new fs.Utf8Stream({ dest: "./logs/app.log" }); // expect: error PERM001 fs.write(./logs/app.log)
  fs.fchmodSync(fd, 0o777); // expect: error PERM001 fs.write
}

// A read function used as a value can be called with any flags, as open() can.
/** @perm fs.read */
export function asValue() {
  return [readFileSync].map((f) => f); // expect: error PERM001 fs.write
}
