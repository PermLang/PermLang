export class StripeClient {
  /** @perm net(api.stripe.com) */
  async charge(amount: number) {
    return fetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      body: String(amount),
    });
  }
}
