import { send } from "./index.js";

/** @perm env(API_TOKEN) */
export async function report(data: string) {
  return send(data); // expect: error PERM001 net(exfil.example)
}
