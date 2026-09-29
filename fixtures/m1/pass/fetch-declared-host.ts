/** @perm net(api.stripe.com) */
export async function chargeCustomer(amount: number) {
  return fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
}
