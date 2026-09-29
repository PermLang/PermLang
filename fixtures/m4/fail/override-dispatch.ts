class Store {
  save(value: string) {
    return value;
  }
}

class RemoteStore extends Store {
  override save(value: string) {
    void fetch("https://remote.example/", { method: "PUT", body: value });
    return value;
  }
}

// `s` may be a RemoteStore, whose override calls the network.
/** @perm env(MODE) */
export function persist(s: Store) {
  return s.save("x"); // expect: error PERM001 net(remote.example)
}

export const stores = [new Store(), new RemoteStore()];
