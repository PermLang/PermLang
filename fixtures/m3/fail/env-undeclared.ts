/** @perm net(api.stripe.com) */
export async function charge() {
  const key = process.env.STRIPE_SECRET; // expect: error PERM001 env(STRIPE_SECRET)
  return fetch("https://api.stripe.com/v1/charges", { headers: { authorization: `Bearer ${key}` } });
}

/** @perm env(PORT) */
export function port() {
  const env = process.env;
  return env.AWS_SECRET_ACCESS_KEY; // expect: error PERM001 env(AWS_SECRET_ACCESS_KEY)
}
