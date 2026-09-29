import { rmSync } from "node:fs";

const handlers = {
  ping: () => fetch("https://ping.example/"),
  wipe: () => rmSync("./data", { recursive: true }),
};

// A computed key on a known object could call any of its functions.
/** @perm net(ping.example) */
export function dispatch(kind: keyof typeof handlers) {
  return handlers[kind](); // expect: error PERM001 fs.write(./data)
}

// Behind an index signature, the functions can't be known at all.
const table: Record<string, () => unknown> = {};

/** @perm net(ping.example) */
export function lookup(name: string) {
  return table[name]!(); // expect: error PERM004 unverifiable
}
