/** @perm env(DB_URL), env(DB_POOL), env(PORT) */
export function dbConfig() {
  const { DB_URL, DB_POOL: pool } = process.env;
  const env = process.env;
  return { url: DB_URL, pool, port: env.PORT };
}
