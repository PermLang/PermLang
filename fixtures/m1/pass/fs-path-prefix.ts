import { readFile } from "node:fs/promises";

// A path permission covers everything beneath that directory.
/** @perm fs.read(data) */
export async function loadReport() {
  return readFile("./data/reports/2026/q3.json", "utf8");
}
