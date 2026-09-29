import { stripeGet } from "./stripe.js";

/** @perm net(api.stripe.com) */
export async function listInvoices() {
  return stripeGet("invoices");
}
