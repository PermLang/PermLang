import { readFileSync } from "node:fs";

// Values that are genuinely fixed still resolve exactly.
const BASE = "https://good.example/";
const SAME = BASE;
enum Paths {
  Config = "data/config.json",
}
const ENDPOINTS = { status: "https://good.example/status" } as const;

/** @perm net(good.example), fs.read(data) */
export function fixed() {
  void fetch(SAME);
  void fetch(ENDPOINTS.status);
  return readFileSync(Paths.Config, "utf8");
}
