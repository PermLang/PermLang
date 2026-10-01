// Found in the second review: other ways to reach a package whose types can't be found.
import legacy = require("untyped-require");
import { anything } from "shimmed-package";

export async function run() {
  const mod = await import("untyped-dynamic");
  // Packages PermLang detects directly aren't reported, like the Prisma client's generated runtime imports.
  await import("@prisma/client/runtime/query_compiler.mjs");
  legacy.go();
  anything();
  return mod;
}
