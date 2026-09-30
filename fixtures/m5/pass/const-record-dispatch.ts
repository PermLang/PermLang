// Found in the Umami trial: a const Record's initializer spells out every function,
// so a computed call on it is checkable even though the type is Record<string, Fn>.
const schemas: Record<string, () => { type: string }> = {
  text: () => ({ type: "string" }),
  count: () => ({ type: "number" }),
};

/** @perm env(MODE) */
export function schemaFor(name: string) {
  return schemas[name]?.();
}
