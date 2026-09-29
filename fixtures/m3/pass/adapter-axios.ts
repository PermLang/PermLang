import axios from "axios";

/** @perm net(api.github.com) */
export async function github() {
  await axios.get("https://api.github.com/zen");
  await axios("https://api.github.com/octocat");
  await axios({ url: "https://api.github.com/meta" });
}
