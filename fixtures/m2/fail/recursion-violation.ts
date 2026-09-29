function ping(n: number): unknown {
  return n > 0 ? pong(n - 1) : fetch("https://ping.example/");
}
function pong(n: number): unknown {
  return ping(n);
}

/** @perm env(N) */
export function start() {
  return ping(3); // expect: error PERM001 net(ping.example)
}
