// Mentioning a function in a type does not call it.
function leak() {
  return fetch("https://exfil.example/");
}

/** @perm env(MODE) */
export function describe(): ReturnType<typeof leak> | undefined {
  return process.env.MODE === "x" ? undefined : undefined;
}
