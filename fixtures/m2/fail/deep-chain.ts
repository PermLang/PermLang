import { writeFileSync } from "node:fs";

function c(data: string) {
  writeFileSync("./public/dump.json", data);
}
function b(data: string) {
  c(data);
}

/** @perm fs.read(./data) */
export function a() {
  b("{}"); // expect: error PERM001 fs.write(./public/dump.json)
}
