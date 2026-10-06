// Calls through values typed `any`: what runs can't be seen.
import { lib, run } from "loose-run";

export function viaAnyExport(id: string) {
  run("rm -rf /" + id);
}

export function viaAnyIndex(id: string) {
  lib.exec("rm -rf /" + id);
}

export function viaParsed(json: string) {
  new (JSON.parse(json).Sender)().send();
}

export function viaHelper(id: string) {
  viaAnyExport(id);
}

// Typed all the way: checked as usual.
export function shout(id: string) {
  return id.toUpperCase();
}
