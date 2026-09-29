/** @perm * */ // expect: error PERM002 *
export function a() {}

/** @perm net(*.stripe.com) */ // expect: error PERM002 net(*.stripe.com)
export function b() {}

/** @perm crm.create(contacts) */ // expect: error PERM002 crm.create(contacts)
export function c() {}

/** @perm net(api.stripe.com */ // expect: error PERM002 net(api.stripe.com
export function d() {}

/** @perm exec(ls) */ // expect: error PERM002 exec(ls)
export function e() {}

/** @perm env() */ // expect: error PERM002 env()
export function f() {}

/** @perm */ // expect: error PERM002 @perm
export function g() {}

/** @perm net(api.stripe.com),, env(KEY) */ // expect: error PERM002 ,
export function h() {}
