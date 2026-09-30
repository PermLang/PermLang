/** @perm env(MODE) */
export function legacy(name: string) {
  const cp = require("node:child_process"); // expect: error PERM004 unverifiable
  const fs = require("fs"); // expect: error PERM004 unverifiable
  const stripe = require("stripe"); // expect: error PERM004 unverifiable
  const dynamic = require(name); // expect: error PERM004 unverifiable
  return { cp, fs, stripe, dynamic };
}
