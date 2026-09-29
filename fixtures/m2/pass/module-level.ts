/**
 * Stripe integration. Every function here may call Stripe.
 * @module
 * @perm net(api.stripe.com)
 */

export async function getBalance() {
  return fetch("https://api.stripe.com/v1/balance");
}

/** @perm env(STRIPE_KEY) */
export async function authedBalance() {
  const key = process.env.STRIPE_KEY;
  return fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` } });
}
