import { openSync, writeSync, closeSync } from "node:fs";

// Access is granted when the file is opened; operations on the descriptor add nothing.
/** @perm fs.write(./logs) */
export function appendLog(line: string) {
  const fd = openSync("./logs/app.log", "a");
  writeSync(fd, line + "\n");
  closeSync(fd);
}
