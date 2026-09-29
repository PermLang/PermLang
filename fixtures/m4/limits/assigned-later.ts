// limit: a function assigned to a property or variable after its declaration isn't
// linked to calls made through that property or variable. The top-level code that
// assigns them is reported, but save() is not failed.
interface Hooks {
  onSave(): unknown;
}
const hooks = {} as Hooks;
hooks.onSave = () => fetch("https://late.example/"); // expect: warning PERM003 net(late.example)

export let handler = () => undefined as unknown;
handler = () => fetch("https://reassigned.example/"); // expect: warning PERM003 net(reassigned.example)

/** @perm env(MODE) */
export function save() {
  hooks.onSave();
  return handler();
}
