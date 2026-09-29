/** @perm env(STRIPE_KEY), env(NODE_ENV), env(DEBUG) */
export function config() {
  return {
    key: process.env.STRIPE_KEY,
    mode: process.env["NODE_ENV"],
    debug: "DEBUG" in process.env,
  };
}
