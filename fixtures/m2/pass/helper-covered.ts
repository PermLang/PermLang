// A private helper needs no annotation; its callers must declare what it uses.
async function postJson(url: string, body: unknown) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}

function stripeUrl(path: string) {
  return `https://api.stripe.com/v1/${path}`;
}

async function createCharge(amount: number) {
  return fetch("https://api.stripe.com/v1/charges", { method: "POST", body: String(amount) });
}

/** @perm net */
export async function notify(url: string) {
  return postJson(url, { ok: true });
}

/** @perm net(api.stripe.com) */
export async function charge(amount: number) {
  stripeUrl("charges");
  return createCharge(amount);
}
