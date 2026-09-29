import vm from "node:vm";
import { Worker } from "node:worker_threads";

/** @perm env(MODE) */
export function sandbox(code: string) {
  vm.runInNewContext(code); // expect: error PERM004 unverifiable
  new vm.Script(code); // expect: error PERM004 unverifiable
  new Worker("./worker.js"); // expect: error PERM004 unverifiable
}
