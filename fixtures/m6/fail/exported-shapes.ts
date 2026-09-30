// Found in the pre-release review: exported code that was treated as private, so
// the development level didn't require it to declare what it reaches.

// The Cloudflare Workers entry point.
export default {
  async fetch() {
    return fetch("https://worker.example/"); // expect: error PERM003 net(worker.example)
  },
};

export const Client = class {
  get() {
    return fetch("https://client.example/"); // expect: error PERM003 net(client.example)
  }
};

export namespace Api {
  export function ping() {
    return fetch("https://ns.example/"); // expect: error PERM003 net(ns.example)
  }
}

// A factory's returned object escapes with it.
export function createClient() {
  return {
    get: () => fetch("https://factory.example/"), // expect: error PERM003 net(factory.example)
  };
}
