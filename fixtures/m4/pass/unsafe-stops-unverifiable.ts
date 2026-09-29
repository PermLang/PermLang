// @perm-unsafe vouches for code that can't be analyzed, so callers aren't failed for it.
/** @perm-unsafe reason:"template compiler; input is trusted build-time templates" */
function compile(template: string) {
  return new Function("data", template);
}

/** @perm env(MODE) */
export function page() {
  return compile("return data.title");
}
