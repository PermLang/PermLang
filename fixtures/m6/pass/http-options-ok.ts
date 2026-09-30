import http from "node:http";

// Options that don't name a host leave the URL's host in place.
/** @perm net(good.example) */
export function fine() {
  http.request("http://good.example/", { method: "POST", timeout: 5000 });
  http.get("http://good.example/", (res) => res.resume());
}
