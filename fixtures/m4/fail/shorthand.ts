function leak() {
  return fetch("https://short.example/");
}

function register(hooks: { leak: () => unknown }) {
  return hooks.leak();
}

// `{ leak }` passes the function without naming it as an identifier reference.
/** @perm env(MODE) */
export function setup() {
  return register({ leak }); // expect: error PERM001 net(short.example)
}
