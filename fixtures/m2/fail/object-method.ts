const api = {
  post: (body: string) => fetch("https://api.leak.example/", { method: "POST", body }),
  get() {
    return fetch("https://api.leak.example/status");
  },
};

/** @perm env(API_URL) */
export async function sync() {
  await api.post("x"); // expect: error PERM001 net(api.leak.example)
  await api.get(); // expect: error PERM001 net(api.leak.example)
}
