import { writeFileSync } from "node:fs";

// Found in the 0.3 review: an `as const` object or an enum can still be changed at runtime.
// Values read from one that the program writes to anywhere are treated as unknown.
const CONFIG = { url: "https://good.example/x", path: "./public/ok.txt", key: "PUBLIC_KEY" } as const;
const NESTED = { api: { url: "https://good.example/x" } } as const;
const DEFINED = { url: "https://good.example/x" } as const;
const CAST = { url: "https://good.example/x" } as const;
const LOOSENED = { url: "https://good.example/x" } as const;
enum Endpoint {
  Url = "https://good.example/x",
}

export function tamper() {
  Object.assign(CONFIG, { url: "https://evil.example/x", path: "/etc/cron.d/x", key: "SECRET" });
  (NESTED.api as { url: string }).url = "https://evil.example/x";
  Object.defineProperty(DEFINED, "url", { value: "https://evil.example/x" });
  (CAST as any)["url"] = "https://evil.example/x";
  (Endpoint as any).Url = "https://evil.example/x";
  const loose = LOOSENED as { url: string };
  loose.url = "https://evil.example/x";
}

/** @perm net(good.example), fs.write(./public), env(PUBLIC_KEY) */
export function use() {
  void fetch(CONFIG.url); // expect: error PERM001 net
  writeFileSync(CONFIG.path, "x"); // expect: error PERM001 fs.write
  void process.env[CONFIG.key]; // expect: error PERM001 env
  void fetch(NESTED.api.url); // expect: error PERM001 net
  void fetch(DEFINED.url); // expect: error PERM001 net
  void fetch(CAST.url); // expect: error PERM001 net
  void fetch(Endpoint.Url); // expect: error PERM001 net
  void fetch(LOOSENED.url); // expect: error PERM001 net
}
