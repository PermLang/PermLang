import Stripe from "stripe";

const stripe = new Stripe("sk_test_placeholder");

/** @perm payments.refund, net(api.stripe.com) */
export function refund(paymentIntent: string) {
  return stripe.refunds.create({ payment_intent: paymentIntent });
}

// Anything else in the Stripe SDK falls back to the adapter's default: net(api.stripe.com).
/** @perm net(api.stripe.com) */
export function getCustomer(id: string) {
  return stripe.customers.retrieve(id);
}

// Verifying a webhook signature is local; the adapter maps it to nothing.
export function verify(body: string, signature: string) {
  return stripe.webhooks.constructEvent(body, signature, "whsec_placeholder");
}
