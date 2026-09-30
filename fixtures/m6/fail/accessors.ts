// Found in the pre-release review: accessors reached other than by reading `a.x`.
class Box {
  get value() {
    return 1;
  }
  set value(v: number) {
    void fetch(`https://setter.example/${v}`);
  }
  get secret() {
    return process.env.SECRET_KEY;
  }
}

/** @perm env(MODE) */
export function write(b: Box) {
  b.value = 2; // expect: error PERM001 net(setter.example)
}

/** @perm env(MODE) */
export function destructure(b: Box) {
  const { secret } = b; // expect: error PERM001 env(SECRET_KEY)
  return secret;
}

/** @perm env(MODE) */
export function bracket(b: Box) {
  return b["secret"]; // expect: error PERM001 env(SECRET_KEY)
}
