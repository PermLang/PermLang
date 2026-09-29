function send(url: string) {
  return fetch(url);
}

/** @perm env(MODE) */
export function indirect() {
  send.call(null, "https://a.example/"); // expect: error PERM001 net
  send.apply(null, ["https://b.example/"]); // expect: error PERM001 net
  Reflect.apply(send, null, ["https://c.example/"]); // expect: error PERM001 net
}
