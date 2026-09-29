class Config {
  get secret() {
    return process.env.SECRET_KEY;
  }
}

// Reading a property can run a getter.
/** @perm env(PUBLIC_URL) */
export function read(c: Config) {
  return c.secret; // expect: error PERM001 env(SECRET_KEY)
}
