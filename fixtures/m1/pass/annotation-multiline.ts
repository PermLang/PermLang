/**
 * Charges a lead and records it.
 *
 * @param leadId - the lead to charge
 * @perm net(api.stripe.com), db.write(leads),
 *       env(STRIPE_KEY)
 * @returns the Stripe response
 */
export const chargeLead = async (leadId: string) => {
  // The host is fixed by the template's literal head, so it is still known.
  return fetch(`https://api.stripe.com/v1/charges?lead=${leadId}`);
};
