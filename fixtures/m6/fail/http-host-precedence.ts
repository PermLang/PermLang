import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

declare const options: http.RequestOptions;
declare function pickKey(): string;

// Found in the 0.3 review: Node connects to `hostname` before `host` and ignores an options
// object's `url`; a spread, an accessor, a computed key, socketPath, lookup, or createConnection
// can send the request somewhere else.
/** @perm net(good.example) */
export function precedence(hostname: string) {
  http.request({ hostname: "evil.example", host: "good.example" }); // expect: error PERM001 net(evil.example)
  http.request({ host: "good.example", hostname: "evil.example" }); // expect: error PERM001 net(evil.example)
  http.request({ url: "http://good.example/", path: "/" } as http.RequestOptions); // expect: error PERM001 net
  http.request({ hostname: "good.example", ...options }); // expect: error PERM001 net
  http.request({ ...options, hostname: "good.example" }); // expect: error PERM001 net
  https.get({ hostname, host: "good.example" }); // expect: error PERM001 net
  https.get({ get hostname() { return "evil.example"; }, host: "good.example" }); // expect: error PERM001 net
  https.get({ ["hostname"]: "evil.example", host: "good.example" }); // expect: error PERM001 net(evil.example)
  https.get({ [pickKey()]: "evil.example", host: "good.example" }); // expect: error PERM001 net
  http.request({ hostname: "good.example", socketPath: "/var/run/docker.sock" }); // expect: error PERM001 net
  https.get({ host: "good.example", lookup: (_h: string, _o: object, cb: (e: null, a: string, f: number) => void) => cb(null, "203.0.113.1", 4) } as https.RequestOptions); // expect: error PERM001 net
  http.request({ hostname: "good.example", createConnection: () => new net.Socket() }); // expect: error PERM001 net
}

// A URL and then options: the options' hostname replaces the URL's host, their host doesn't.
/** @perm net(good.example) */
export function urlThenOptions() {
  https.get("https://good.example/", { hostname: "evil.example" }); // expect: error PERM001 net(evil.example)
  https.get("https://evil.example/", { host: "good.example" }); // expect: error PERM001 net(evil.example)
  https.get("https://good.example/", { ...options }); // expect: error PERM001 net
  https.get(new URL("https://good.example/"), { socketPath: "/var/run/docker.sock" }); // expect: error PERM001 net
}

// net and tls connect to `host` and ignore `hostname`; `path` is a local socket.
/** @perm net(good.example) */
export function sockets() {
  net.connect({ hostname: "good.example", host: "evil.example", port: 80 } as net.NetConnectOpts); // expect: error PERM001 net(evil.example)
  tls.connect({ host: "good.example", path: "/var/run/docker.sock" }); // expect: error PERM001 net
  net.connect(80, "evil.example"); // expect: error PERM001 net(evil.example)
}
