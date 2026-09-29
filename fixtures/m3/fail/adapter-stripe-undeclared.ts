import Stripe from "stripe";

const stripe = new Stripe("sk_test_placeholder");

/** @perm net(api.stripe.com) */
export function refundAndCharge(id: string) {
  stripe.refunds.create({ payment_intent: id }); // expect: error PERM001 payments.refund
  stripe.paymentIntents.create({ amount: 500 }); // expect: error PERM001 payments.charge
}

/** @perm payments.refund */
export function refundOnly(id: string) {
  return stripe.refunds.create({ payment_intent: id }); // expect: error PERM001 net(api.stripe.com)
}
