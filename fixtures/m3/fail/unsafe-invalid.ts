/** @perm-unsafe */ // expect: error PERM002 @perm-unsafe
export function noReason() {}

/** @perm-unsafe reason:"" */ // expect: error PERM002 @perm-unsafe
export function emptyReason() {}
