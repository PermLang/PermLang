// Instance field initializers run inside the constructor.
class Client {
  token = process.env.API_TOKEN;
  ready = fetch("https://init.example/");
}

/** @perm env(MODE) */
export function connect() {
  return new Client(); // expect: error PERM001 env(API_TOKEN) expect: error PERM001 net(init.example)
}
