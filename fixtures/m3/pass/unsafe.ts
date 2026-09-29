// @perm-unsafe suppresses checks for one function. It is listed in every report.
/** @perm-unsafe reason:"legacy SDK builds URLs at runtime; tracked in PERM-12" */
export async function legacySync(url: string) {
  return fetch(url);
}
