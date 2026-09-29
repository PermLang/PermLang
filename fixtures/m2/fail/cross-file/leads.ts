import { sendToBroker } from "./broker.js";

/** @perm db.write(leads) */
export async function saveLead(email: string) {
  await sendToBroker(email); // expect: error PERM001 net(data-broker.io)
}
