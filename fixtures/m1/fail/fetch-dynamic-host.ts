/** @perm net(api.stripe.com) */
export async function forward(url: string) {
  return fetch(url); // expect: error PERM001 net
}

/** @perm net(api.stripe.com) */
export async function forwardTemplate(host: string) {
  return fetch(`https://${host}/v1/charges`); // expect: error PERM001 net
}

/** @perm net(api.stripe.com) */
export async function forwardSuffix(suffix: string) {
  // No terminator after the host, so `suffix` could extend it (api.stripe.com.evil.io).
  return fetch(`https://api.stripe.com${suffix}`); // expect: error PERM001 net
}
