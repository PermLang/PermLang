/** @perm net(api.stripe.com) */
export async function charge() {
  await fetch("https://api.stripe.com.evil.io/v1/charges"); // expect: error PERM001 net(api.stripe.com.evil.io)
  await fetch("https://api.stripe.com@evil.io/v1/charges"); // expect: error PERM001 net(evil.io)
  await fetch(`https://api.stripe.com.evil.io/${"x"}`); // expect: error PERM001 net(api.stripe.com.evil.io)
}
