/** @perm net(api.stripe.com) */
export async function stripeGet(path: string) {
  return fetch(`https://api.stripe.com/v1/${path}`);
}
