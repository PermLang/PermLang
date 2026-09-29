import { readdirSync, statSync } from "node:fs";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => visit(`${dir}/${name}`));
}

function visit(path: string): string[] {
  return statSync(path).isDirectory() ? walk(path) : [path];
}

/** @perm fs.read */
export function listFiles(root: string) {
  return walk(root);
}
