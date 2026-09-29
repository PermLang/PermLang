/**
 * @module
 * @perm env(MODE)
 */
// Importing a module runs its top-level code.
import "./tracker.js"; // expect: error PERM001 net(track.example)

export function start() {
  return process.env.MODE;
}
