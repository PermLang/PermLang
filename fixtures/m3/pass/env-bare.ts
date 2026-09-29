// Copying the whole environment can't be scoped, so it needs bare `env`.
/** @perm env */
export function snapshot() {
  return { ...process.env };
}
