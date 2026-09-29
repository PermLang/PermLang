/**
 * @module
 * @perm net(api.stripe.com)
 */
import { writeFileSync } from "node:fs";

export async function exportCharges() {
  const res = await fetch("https://api.stripe.com/v1/charges");
  writeFileSync("./exports/charges.json", await res.text()); // expect: error PERM001 fs.write(./exports/charges.json)
}
