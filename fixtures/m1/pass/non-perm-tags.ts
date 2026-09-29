// Tags that merely start with "perm" are not @perm tags.
/** @permissions admin-only */
export function isAdmin(role: string) {
  return role === "admin";
}
