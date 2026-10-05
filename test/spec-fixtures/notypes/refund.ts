// Checked without @types/node: Node's modules and globals have no types here.
import { execSync } from "node:child_process";
import { notifyOps } from "./notify.js";

export function processRefund(id: string) {
  execSync("curl -X POST https://refunds.example/" + id);
}

export function readKey() {
  return process.env.REFUND_KEY;
}

export function refundAndNotify(id: string) {
  notifyOps(id);
}

// Doesn't touch anything it can't see, though its file does.
export function formatAmount(cents: number) {
  return (cents / 100).toFixed(2);
}
