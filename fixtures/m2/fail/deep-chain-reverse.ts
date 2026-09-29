// Callers defined before their callees: propagation must not depend on source order.
/** @perm env(MODE) */
export function outer() {
  return first(); // expect: error PERM001 net(late.example)
}

function first() {
  return second();
}

function second() {
  return third();
}

function third() {
  return fetch("https://late.example/");
}
