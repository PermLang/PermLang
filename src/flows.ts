// Data-flow rules: where a secret or sensitive data may be sent.
//
//   "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)", "email.send"] }]
//
// A function that gets hold of the source, and can send it somewhere the rule doesn't list
// (itself or through what it calls), is a PERM009 error. Somewhere is a host (including one
// that can't be determined), or an app capability from an adapter (`email.send`). A command,
// code that can't be verified, and a package PermLang can't see into (no adapter, or no
// types) could send it anywhere, so no rule allows them. A function gets hold of the source
// by reading it, or by calling something that has it and can hand it back. This doesn't
// follow the value: a key stored somewhere (a module-level constant, an object's field) and
// read by other code isn't caught.

import { Node, SyntaxKind, type ParameterDeclaration, type SourceFile, type Type } from "ts-morph";
import type { AdapterIndex } from "./adapters.js";
import { BUILTIN_VOCABULARY, CAPABILITY_NAME, UNVERIFIABLE, covers, formatCapability, parsePermList, type Capability } from "./capability.js";
import type { Diagnostic } from "./check.js";
import { callText } from "./detect/shared.js";
import { pathTo, type Edge, type Reach } from "./graph.js";
import { unmappedCalls } from "./unmapped.js";
import { untypedImportUses } from "./unseen.js";
import { enclosingUnitNode, type Unit, type Use } from "./units.js";
import { lineAndColumn } from "./walk.js";

export interface FlowRule {
  /** What's protected, such as env(STRIPE_KEY) or db.read(customers). */
  from: Capability;
  /** Where it may go: network hosts, and app capabilities from adapters (`email.send`). */
  to: Capability[];
}

/** A flow rule that can't be checked as written. The CLI reports it as a configuration error. */
export class FlowRuleError extends Error {}

/** What a rule can protect: data a function reads. Writes and commands aren't data. */
const SOURCES = ["env", "fs.read", "db.read", "net"];

// Calls whose destination can't be seen, counted for flow rules only (see opaqueUses). The
// names can't be capabilities (a `-` isn't allowed in one), so they can't clash with an adapter's.
const NO_ADAPTER = "no-adapter";
const NO_TYPES = "no-types";

/**
 * Validates the `flows` setting from permlang.config.json.
 * @throws Error describing the first problem.
 */
export function parseFlows(raw: unknown, source: string): FlowRule[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: "flows" must be a list of { "from": ..., "to": [...] } rules.`);
  return raw.map((rule, i) => {
    const r = rule as { from?: unknown; to?: unknown };
    if (typeof rule !== "object" || rule === null || typeof r.from !== "string") throw new Error(`${source}: flows[${i}] needs a "from" capability, such as "env(STRIPE_KEY)".`);
    // A misspelled setting would otherwise be ignored, and the rule would check less than it says.
    const unknown = Object.keys(rule).find((key) => key !== "from" && key !== "to");
    if (unknown !== undefined) throw new Error(`${source}: flows[${i}] has an unknown setting "${unknown}"; a rule has only "from" and "to".`);
    if (!Array.isArray(r.to) || !r.to.every((t) => typeof t === "string")) throw new Error(`${source}: flows[${i}]: "to" must be a list of capabilities, such as ["net(api.stripe.com)"].`);
    const from = one(r.from, `flows[${i}]: invalid "from"`, source);
    if (!SOURCES.includes(from.name)) {
      throw new Error(`${source}: flows[${i}]: "from" must be data a function can read: env, fs.read, db.read, or net, with or without a scope; "${r.from}" isn't.`);
    }
    hostOnly(from, `flows[${i}]`, source);
    const to = (r.to as string[]).map((t) => {
      // An app capability's name is checked against the adapters later (checkFlowTargets): they aren't loaded yet.
      const name = /^\s*([^()\s]+)/.exec(t)?.[1];
      const sink = one(t, `flows[${i}]: invalid "to" entry`, source, name !== undefined && CAPABILITY_NAME.test(name) ? name : undefined);
      if (sink.name !== "net" && (BUILTIN_VOCABULARY.has(sink.name) || sink.name === UNVERIFIABLE)) {
        throw new Error(`${source}: flows[${i}]: "to" can only list network hosts, such as "net(api.stripe.com)", and app capabilities from adapters, such as "email.send"; "${t}" isn't one.`);
      }
      return hostOnly(sink, `flows[${i}]`, source);
    });
    return { from, to };
  });
}

/**
 * Checks that the app capabilities rules list in `to` are ones the adapters define: a
 * misspelled one could never match, and would fail the calls it was meant to allow.
 * @throws FlowRuleError naming the first one that isn't.
 */
export function checkFlowTargets(rules: readonly FlowRule[], vocabulary: ReadonlySet<string>): void {
  const defined = [...vocabulary].filter((name) => !BUILTIN_VOCABULARY.has(name)).sort();
  for (const [i, rule] of rules.entries()) {
    const unknown = rule.to.find((t) => !vocabulary.has(t.name));
    if (unknown === undefined) continue;
    const listed = defined.length > 0 ? `Adapters define: ${defined.join(", ")}.` : "No adapter defines any.";
    throw new FlowRuleError(`flows[${i}]: "to" lists ${formatCapability(unknown)}, which no adapter defines, so it could never match. ${listed}`);
  }
}

/**
 * A `net` scope must be a host as calls report it (detect/shared.ts, hostOf): the host a call
 * connects to, never its scheme, port, path, or user. `net(https://api.stripe.com)` or
 * `net(api.stripe.com:443)` could never match, and would fail the calls it was meant to allow.
 * An IPv6 address is written in brackets, as URLs write it: `net([::1])`.
 * @throws Error naming the host to write instead.
 */
function hostOnly(capability: Capability, where: string, source: string): Capability {
  const arg = capability.arg;
  if (capability.name !== "net" || arg === undefined || !/[/:@?#\s\\]/.test(arg.replace(/^\[[^\]]*\]$/, ""))) return capability;
  let host: string | undefined;
  try {
    host = new URL(arg.includes("://") ? arg : `x://${arg}`).hostname || undefined;
  } catch {
    host = undefined;
  }
  const instead = host ? `write "net(${host})"` : `write only the host, such as "net(api.stripe.com)" or "net([::1])"`;
  throw new Error(`${source}: ${where}: "${formatCapability(capability)}" names more than a host. A rule matches the host a call connects to, whatever its scheme, port, or path: ${instead}.`);
}

function one(text: string, what: string, source: string, appCapability?: string): Capability {
  const vocabulary = appCapability === undefined ? BUILTIN_VOCABULARY : new Set([...BUILTIN_VOCABULARY, appCapability]);
  const { capabilities, errors } = parsePermList(text, vocabulary);
  if (errors.length > 0 || capabilities.length !== 1) throw new Error(`${source}: ${what} "${text}"${errors[0] ? `: ${errors[0].reason}` : ""}.`);
  return capabilities[0]!;
}

/** One error per function, rule, and place the rule doesn't allow. */
export function flowDiagnostics(units: Iterable<Unit>, edges: readonly Edge[], reach: Reach, rules: readonly FlowRule[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Listed once: an iterator (a Map's values, say) would be used up by the first rule.
  const all = [...units];
  for (const rule of rules) {
    const source = formatCapability(rule.from);
    const allowed = rule.to.length > 0 ? `allows only ${rule.to.map(formatCapability).join(", ")}` : "doesn't let it go anywhere";
    for (const [unit, via] of holders(all, edges, rule)) {
      const got = via.length === 0 ? `reads ${source}` : `gets ${source} from ${via.join(" → ")}`;
      for (const [key, p] of reach.get(unit)!) {
        const sink = sinkOf(key, p.capability, rule, source, allowed);
        if (!sink) continue;
        const site = p.edge ?? p.use;
        const path = pathTo(reach, unit, key);
        out.push({
          severity: "error",
          code: "PERM009",
          file: unit.file,
          line: site.line,
          column: site.column,
          function: unit.name,
          capability: sink.capability,
          call: site.call,
          path,
          message: `${unit.name} ${got} and ${sink.does}, through ${path.join(" → ")}, ${sink.why}.`,
          fix: sink.fix,
        });
      }
    }
  }
  return out;
}

/** Where a capability a holder reaches could take the data, when the rule doesn't allow it. */
interface Sink {
  /** What the holder can do, as in "viaEmail reads env(KEY) and ___". */
  does: string;
  /** Why the rule fails, after the path to it. */
  why: string;
  fix: string;
  /** For the diagnostic: the capability, or the package that can't be seen into. */
  capability: string;
}

/** Undefined when the capability takes the data nowhere the rule cares about: a read, a write, or a destination it allows. */
function sinkOf(key: string, capability: Capability, rule: FlowRule, source: string, allowed: string): Sink | undefined {
  const keep = `keep ${source} away from that call`;
  const anywhere = `the flow rule for ${source} ${allowed}`;
  const notAllowed = `which the flow rule for ${source} doesn't allow`;
  const listIt = `${keep}, or add ${key} to the rule's "to" in permlang.config.json.`;
  switch (capability.name) {
    case "exec":
      return { does: "can run commands", why: `which could send it anywhere: ${anywhere}`, fix: `${keep}: no rule can allow it, since a command could send it anywhere.`, capability: key };
    case UNVERIFIABLE:
      return { does: "runs code that can't be verified", why: `which could send it anywhere: ${anywhere}`, fix: `${keep}: no rule can allow it, since code that can't be verified could send it anywhere.`, capability: key };
    case NO_ADAPTER:
      return {
        does: `calls into ${capability.arg}, which has no adapter`,
        why: `so it could send it anywhere: ${anywhere}`,
        fix: `add an adapter manifest for ${capability.arg}, so PermLang knows where it sends data (see docs/reference.md#adapter-manifests), or ${keep}.`,
        capability: capability.arg!,
      };
    case NO_TYPES:
      return {
        does: `calls into ${capability.arg}, whose types can't be found`,
        why: `so it could send it anywhere: ${anywhere}`,
        fix: `install the types for ${capability.arg}, so PermLang can see what it calls, or ${keep}.`,
        capability: capability.arg!,
      };
    case "net":
      if (covers(rule.to, capability)) return undefined;
      return capability.arg === undefined
        ? { does: `can send to ${key} (a host that can't be determined)`, why: notAllowed, fix: `${keep}, or make its host fixed so the rule can allow it.`, capability: key }
        : { does: `can send to ${key}`, why: notAllowed, fix: listIt, capability: key };
    default:
      // An app capability from an adapter (email.send, payments.refund) takes the data wherever that action goes.
      if (BUILTIN_VOCABULARY.has(capability.name) || covers(rule.to, capability)) return undefined;
      return { does: `can reach ${key}`, why: notAllowed, fix: listIt, capability: key };
  }
}

/**
 * Calls whose destination can't be seen, as uses for flow rules only: calls into a package
 * with no adapter (what PERM006 warns about), and uses of an import whose types can't be found
 * (PERM007). Either could send what it's given anywhere. They aren't capabilities a function
 * declares, so they're kept out of what @perm, the lock, and AI tools see.
 */
export function opaqueUses(sourceFiles: readonly SourceFile[], adapters: AdapterIndex, unitOf: (node: Node) => Unit | undefined): Map<Unit, Use[]> {
  const out = new Map<Unit, Use[]>();
  const add = (node: Node, capability: Capability, call: string) => {
    const unit = unitOf(enclosingUnitNode(node));
    if (!unit) return;
    const { line, column } = lineAndColumn(node.getSourceFile(), node.getStart());
    const uses = out.get(unit) ?? [];
    uses.push({ verb: "calls", capability, call, line, column });
    out.set(unit, uses);
  };
  for (const { node, package: pkg } of unmappedCalls(sourceFiles, adapters)) add(node, { name: NO_ADAPTER, arg: pkg }, callText(node));
  for (const sourceFile of sourceFiles) {
    for (const { node, specifier } of untypedImportUses(sourceFile)) add(node, { name: NO_TYPES, arg: specifier }, siteText(node));
  }
  return out;
}

/** A name as messages show it: the call it's the callee of (`post(...)`, `ns.post(...)`), else the name. */
function siteText(name: Node): string {
  let callee = name;
  for (let parent = callee.getParent(); parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === callee; parent = callee.getParent()) callee = parent;
  const call = callee.getParent();
  return call && (Node.isCallExpression(call) || Node.isNewExpression(call)) && call.getExpression() === callee ? callText(call) : name.getText();
}

/**
 * The units that can get hold of the rule's source, each with where it comes from (empty
 * for a direct read). A unit has it when it reads it (or something broader, such as the
 * whole environment), or when it calls a unit that has it and can hand it back.
 */
function holders(units: Iterable<Unit>, edges: readonly Edge[], rule: FlowRule): Map<Unit, string[]> {
  const has = new Map<Unit, string[]>();
  for (const unit of units) {
    if (unit.uses.some((u) => covers([rule.from], u.capability) || covers([u.capability], rule.from))) has.set(unit, []);
  }
  // Fixed point: each pass can only add units, so it ends.
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      const from = has.get(edge.to);
      if (from === undefined || has.has(edge.from) || !handsBack(edge.to)) continue;
      has.set(edge.from, [edge.to.name, ...from]);
      changed = true;
    }
  }
  return has;
}

/**
 * Whether what a unit has can come back to its caller: through a return value, a callback the
 * caller passed in, the object a constructor builds, or a module's exports. A function that
 * returns nothing (`void`) and takes no callback can't hand anything back, which keeps a caller
 * of `chargeCustomer(): Promise<void>` from being flagged for what it sends elsewhere.
 */
function handsBack(unit: Unit): boolean {
  const node = unit.node;
  if (Node.isSetAccessorDeclaration(node)) return false;
  const fn = Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node) ? node.getInitializer() : node;
  // A module (its exports) or a constructor (the object it builds), explicit or implicit.
  if (!fn || !(Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    return true;
  }
  if (fn.getParameters().some((p) => p.getType().getCallSignatures().length > 0 || p.getType().getUnionTypes().some((t) => t.getCallSignatures().length > 0))) return true;
  return !returnsNothing(fn.getReturnType());
}

function returnsNothing(type: Type): boolean {
  if (type.isUnion()) return type.getUnionTypes().every(returnsNothing);
  if (type.isVoid() || type.isUndefined() || type.isNull() || type.isNever()) return true;
  const awaited = type.getSymbol()?.getName() === "Promise" ? type.getTypeArguments()[0] : undefined;
  return awaited !== undefined && returnsNothing(awaited);
}
