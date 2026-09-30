// Used by test/strictness.test.ts and test/lock.test.ts.

function helper() {
  return fetch("https://helper.example/");
}

export function unannotated() {
  return helper();
}

/** @perm env(MODE) */
export function annotated() {
  return fetch("https://x.example/");
}

/** @perm * */
export function badAnnotation() {}
