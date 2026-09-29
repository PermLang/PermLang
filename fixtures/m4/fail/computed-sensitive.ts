import * as fs from "node:fs";

// A computed key on a sensitive module can reach any of its functions.
/** @perm fs.read(./data) */
export function pick(method: "readFileSync" | "unlinkSync") {
  return fs[method]("./data/x"); // expect: error PERM004 unverifiable
}

// A literal key resolves like a normal call.
/** @perm env(MODE) */
export function literal() {
  return globalThis["fetch"]("https://literal.example/"); // expect: error PERM001 net(literal.example)
}
