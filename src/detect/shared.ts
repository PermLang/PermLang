// Helpers shared by the detectors.

import {
  Node,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type ObjectLiteralExpression,
  type Symbol as MorphSymbol,
  type Identifier,
  type TaggedTemplateExpression,
  type Type,
} from "ts-morph";
import type { Capability } from "../capability.js";

export type CallLike = CallExpression | NewExpression | TaggedTemplateExpression;

export interface CapabilityUse {
  capability: Capability;
  /** The code as written, shortened for messages. */
  call: string;
  /** How messages describe the use: "calls fetch(...)", "reads process.env.X", "uses fetch as a value". */
  verb: "calls" | "reads" | "uses";
}

export function resolveAlias(symbol: MorphSymbol): MorphSymbol {
  return symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
}

export function argumentsOf(call: CallLike): Node[] {
  return Node.isTaggedTemplateExpression(call) ? [] : call.getArguments();
}

export function callText(call: CallLike): string {
  if (Node.isTaggedTemplateExpression(call)) return `${call.getTag().getText()}\`...\``;
  const args = call.getArguments();
  const first = args[0]?.getText() ?? "";
  const shown = (first.length > 60 ? `${first.slice(0, 57)}...` : first) + (args.length > 1 ? ", ..." : "");
  const prefix = Node.isNewExpression(call) ? "new " : "";
  return `${prefix}${call.getExpression().getText()}(${shown})`.replace(/\s+/g, " ");
}

/**
 * A string argument's value when it is known statically: a literal, a `const`
 * holding one (also as a `{ name }` shorthand), a string enum member, or a
 * property of an `as const` object.
 * Undefined when it is computed.
 *
 * The value is traced, never taken from the type: the checker doesn't require
 * code to type-check, and `u as "https://good.example/"` has a literal type
 * without a literal value.
 *
 * Enums and `as const` objects can still be changed at runtime, so a value read
 * from one that the program writes to anywhere is unknown (see isWritten).
 */
export function literalString(arg: Node | undefined, depth = 0): string | undefined {
  if (!arg || depth > 8) return undefined;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
  if (!Node.isIdentifier(arg) && !Node.isPropertyAccessExpression(arg) && !Node.isShorthandPropertyAssignment(arg)) return undefined;

  const symbol = Node.isShorthandPropertyAssignment(arg)
    ? arg.getValueSymbol()
    : (Node.isPropertyAccessExpression(arg) ? arg.getNameNode() : arg).getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (!declaration) return undefined;
  if (Node.isEnumMember(declaration)) {
    return isWritten(declaration.getParent().getNameNode()) ? undefined : literalString(declaration.getInitializer(), depth + 1);
  }
  if (Node.isVariableDeclaration(declaration)) {
    return isConst(declaration) ? literalString(declaration.getInitializer(), depth + 1) : undefined;
  }
  if (!Node.isPropertyAssignment(declaration)) return undefined;
  const holder = constObjectHolder(declaration);
  return holder && !isWritten(holder) ? literalString(declaration.getInitializer(), depth + 1) : undefined;
}

function isConst(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === "const";
}

/** The name of the `const X` holding `{ ... } as const` that a property belongs to (possibly nested), if it is one. */
function constObjectHolder(property: Node): Identifier | undefined {
  let node = property.getParent();
  while (node && Node.isObjectLiteralExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isAsExpression(parent) && parent.getTypeNode()?.getText() === "const") {
      const holder = parent.getParent();
      const name = Node.isVariableDeclaration(holder) && isConst(holder) ? holder.getNameNode() : undefined;
      return Node.isIdentifier(name) ? name : undefined;
    }
    node = parent && Node.isPropertyAssignment(parent) ? parent.getParent() : undefined;
  }
  return undefined;
}

// --- Fixed values the program changes --------------------------------------------
//
// An `as const` object's properties and an enum's members are readonly only to the
// type checker: `Object.assign(CONFIG, { url })` or `(Endpoint as any).Url = url`
// changes them at runtime. So every reference to the object, anywhere in the
// program, is checked for a write: an assignment, `delete`, `++`/`--`, or
// destructuring into one of its members (`CONFIG.url = ...`, `CONFIG.a.b = ...`);
// a cast (after which anything can happen to it); or being the target of
// Object.assign, Object.defineProperty, Reflect.set, and the like.
//
// Not followed: the object stored in another variable or passed to a function
// that then writes to it. That's a known limit.

// Per program, so that a project edited and checked again (through the library API) is read afresh.
const written = new WeakMap<object, WeakMap<Node, boolean>>();

const WRITING_FUNCTIONS = new Set([
  "Object.assign", "Object.defineProperty", "Object.defineProperties", "Object.setPrototypeOf",
  "Reflect.set", "Reflect.defineProperty", "Reflect.deleteProperty", "Reflect.setPrototypeOf",
]);

/** Whether the program may change an enum or `as const` object, named `name`, after it's created. */
function isWritten(name: Identifier): boolean {
  const program = name.getProject().getProgram().compilerObject;
  const cache = written.get(program) ?? new WeakMap<Node, boolean>();
  written.set(program, cache);
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const result = name.findReferencesAsNodes().some((reference) => writesThrough(reference));
  cache.set(name, result);
  return result;
}

/** Whether one reference to an object writes to it. */
function writesThrough(reference: Node): boolean {
  let chain: Node = reference;
  const parentOfName = reference.getParent();
  // `config.CONFIG`, through a namespace import: the access is the reference.
  if (Node.isPropertyAccessExpression(parentOfName) && parentOfName.getNameNode() === reference) chain = parentOfName;
  let members = 0;
  for (let parent = chain.getParent(); parent; parent = chain.getParent()) {
    if (Node.isAsExpression(parent) || Node.isTypeAssertion(parent)) {
      if (parent.getTypeNode()?.getText() !== "const") return true;
    } else if (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) {
      if (parent.getExpression() !== chain) break;
      members++;
    } else if (!Node.isParenthesizedExpression(parent) && !Node.isNonNullExpression(parent) && !Node.isSatisfiesExpression(parent)) {
      break;
    }
    chain = parent;
  }
  if (isWritingCallTarget(chain)) return true;
  return members > 0 && isAssignedTo(chain);
}

/** `Object.assign(target, ...)` and the like, with `target` as given. */
function isWritingCallTarget(target: Node): boolean {
  const call = target.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== target) return false;
  const callee = unwrapExpression(call.getExpression());
  return Node.isPropertyAccessExpression(callee) && WRITING_FUNCTIONS.has(`${callee.getExpression().getText()}.${callee.getName()}`);
}

/** The target of an assignment, `delete`, `++`/`--`, or a destructuring assignment. */
function isAssignedTo(target: Node): boolean {
  let node = target;
  for (let parent = node.getParent(); parent; node = parent, parent = parent.getParent()) {
    if (Node.isDeleteExpression(parent)) return true;
    if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
      const op = parent.getOperatorToken();
      return op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken;
    }
    if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getKind();
      return parent.getLeft() === node && op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
    }
    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) return parent.getInitializer() === node;
    // Inside a destructuring pattern on the left of `=`: `({ a: CONFIG.url } = evil)`, `[CONFIG.url] = evil`.
    const inPattern = Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) ||
      Node.isPropertyAssignment(parent) || Node.isSpreadElement(parent) || Node.isSpreadAssignment(parent);
    if (!inPattern) return false;
  }
  return false;
}

/**
 * How an object literal sets property `name`: the node that holds its value (an initializer,
 * or a `{ name }` shorthand), "absent" when the literal doesn't set it, or "unknown" when it
 * may set it in a way that can't be read. Later properties win, so a spread, a computed key,
 * or an accessor after the last plain `name: value` makes it unknown.
 */
export function propertyValue(object: ObjectLiteralExpression, name: string): Node | "absent" | "unknown" {
  const properties = object.getProperties();
  for (let i = properties.length - 1; i >= 0; i--) {
    const p = properties[i]!;
    if (Node.isSpreadAssignment(p)) return "unknown";
    const key = propertyKey(p.getNameNode());
    if (key === undefined) return "unknown";
    if (key !== name) continue;
    if (Node.isPropertyAssignment(p)) return p.getInitializerOrThrow();
    if (Node.isShorthandPropertyAssignment(p)) return p;
    return "unknown"; // a getter, setter, or method
  }
  return "absent";
}

/**
 * A property name (`a`, `"a"`, `["a"]`), or undefined for a computed key that can't be known.
 * A number is kept as written, which is enough to tell it from the names looked for.
 */
function propertyKey(name: Node): string | undefined {
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

// Several passes resolve the same calls; signature resolution is the expensive part.
// The cache lasts one check: ts-morph keeps a call's node when the code around it is
// edited, so a Project checked again after an edit would get the old answers.
let resolved = new WeakMap<Node, Node | undefined>();

/** Forgets every resolved call. checkProject calls this before it starts. */
export function clearResolutionCache(): void {
  resolved = new WeakMap();
}

/** The declaration of the signature a call resolves to: the overload, method, or call signature actually used. */
export function resolvedDeclaration(call: CallLike): Node | undefined {
  if (resolved.has(call)) return resolved.get(call);
  let declaration: Node | undefined;
  try {
    declaration = call.getProject().getTypeChecker().getResolvedSignature(call)?.getDeclaration();
  } catch {
    declaration = undefined;
  }
  resolved.set(call, declaration);
  return declaration;
}

/** `Reflect.apply(fn, thisArg, args)`, the standard library's: a call of `fn` with `args`. */
export function isReflectApply(call: CallExpression): boolean {
  const declaration = resolvedDeclaration(call);
  return Node.isFunctionDeclaration(declaration) && declaration.getName() === "apply" &&
    containerName(declaration) === "Reflect" && declaration.getSourceFile().isDeclarationFile();
}

/**
 * A global function or variable from the TypeScript lib or @types/node, such as
 * `fetch` or `eval`: declared in a .d.ts, and not inside a `declare module "x"`
 * package block (`declare global` is fine).
 */
export function isGlobalLibFunction(declaration: Node, name: string): boolean {
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return false;
  if (declaration.getName() !== name || !declaration.getSourceFile().isDeclarationFile()) return false;
  // @types/node nests some globals as `declare module "timers" { global { function setTimeout ... } }`.
  for (const a of declaration.getAncestors()) {
    if (!Node.isModuleDeclaration(a)) continue;
    if (a.getName() === "global") return true;
    if (Node.isStringLiteral(a.getNameNode())) return false;
  }
  return true;
}

/** A string argument, which setTimeout and friends evaluate as code, even when a cast hides it from the type checker. */
export function evaluatesString(arg: Node | undefined): boolean {
  if (!arg) return false;
  const inner = unwrapExpression(arg);
  const type = inner.getType();
  return (
    Node.isStringLiteral(inner) ||
    Node.isNoSubstitutionTemplateLiteral(inner) ||
    Node.isTemplateExpression(inner) ||
    type.isString() ||
    type.isStringLiteral() ||
    type.isTemplateLiteral()
  );
}

/** Whether a string can be given where `type` is expected: `string`, `any`, `unknown`, `{}`, or a union with one (lib.dom's `TimerHandler`). */
export function admitsString(type: Type, at: Node): boolean {
  const checker = at.getProject().getTypeChecker().compilerObject;
  return checker.isTypeAssignableTo(checker.getStringType(), type.compilerType);
}

/** Strips parentheses, `as`, `!`, and `satisfies` to reach the expression underneath. */
export function unwrapExpression(node: Node): Node {
  let n = node;
  while (
    Node.isParenthesizedExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isTypeAssertion(n) ||
    Node.isNonNullExpression(n) ||
    Node.isSatisfiesExpression(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

/** The name of the nearest class, interface, type alias, or namespace a declaration sits in. */
export function containerName(declaration: Node): string | undefined {
  for (const a of declaration.getAncestors()) {
    if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeAliasDeclaration(a)) return a.getName();
    if (Node.isModuleDeclaration(a)) return Node.isStringLiteral(a.getNameNode()) ? undefined : a.getName();
  }
  return undefined;
}

// The host is known only when the literal text contains the whole authority
// (userinfo, host, port): the scheme, then everything up to the first `/`, `?`,
// or `#`. `https://api.stripe.com${x}` and `https://good.example:${p}/` could
// both become any host (`p = "x@evil.example"`).
const TEMPLATE_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)[/?#]/i;

function templateHost(head: string): string | undefined {
  const authority = TEMPLATE_AUTHORITY.exec(head)?.[1];
  if (!authority) return undefined;
  try {
    return new URL(`${authority}/`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// Options that decide where a connection goes without naming a host: a local socket, a custom
// DNS lookup, or a custom connection. Node's http and net, axios, and others all accept them.
const REDIRECTING_OPTIONS = ["socketPath", "lookup", "createConnection"];

/**
 * The host an argument names: a URL string or template, `new URL(...)`, or an options object
 * whose `url`, `hostname`, and `host` (those it sets) all name the same literal host.
 * Undefined when it can't be known, including when an option could send the connection
 * elsewhere (a spread or computed key that could set any of them, an accessor, or one of
 * REDIRECTING_OPTIONS).
 */
export function hostOf(written: Node | undefined): string | undefined {
  if (!written) return undefined;
  const arg = unwrapExpression(written);
  const text = literalString(arg);
  if (text !== undefined) {
    try {
      return new URL(text).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isTemplateExpression(arg)) {
    return templateHost(arg.getHead().getLiteralText());
  }
  // new URL("https://host/path") or new URL("/path", "https://host"), with literal parts.
  if (Node.isNewExpression(arg) && isGlobalUrl(arg.getExpression())) {
    const [input, base] = arg.getArguments().map((a) => literalString(a));
    if (input === undefined || (arg.getArguments().length > 1 && base === undefined)) return undefined;
    try {
      return new URL(input, base).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isObjectLiteralExpression(arg)) {
    if (redirects(arg, REDIRECTING_OPTIONS)) return undefined;
    let host: string | undefined;
    for (const key of ["url", "hostname", "host"]) {
      const value = propertyValue(arg, key);
      if (value === "absent") continue;
      const named = value === "unknown" ? undefined : key === "url" ? hostOf(value) : hostName(value);
      if (named === undefined || (host !== undefined && named !== host)) return undefined;
      host = named;
    }
    return host;
  }
  return undefined;
}

/**
 * Where Node's http.request(input, options) connects, and https's, http.get's, and
 * ClientRequest's. Node reads `hostname` before `host` and ignores an options object's `url`.
 * After a URL or URL string, options are merged over it: their `hostname` replaces the URL's
 * host, but their `host` doesn't, because the URL sets `hostname`. (lib/_http_client.js; the
 * reference has a test of each order.)
 */
export function nodeRequestHost(args: readonly Node[], index: number): string | undefined {
  const input = args[index] && unwrapExpression(args[index]);
  if (!input) return undefined;
  if (Node.isObjectLiteralExpression(input)) {
    if (redirects(input, REDIRECTING_OPTIONS) || agentRedirects(input)) return undefined;
    const hostname = propertyValue(input, "hostname");
    // Without a hostname or host, Node connects to localhost; the reference treats that as unknown.
    return hostname === "absent" ? optionHost(input, "host") : hostname === "unknown" ? undefined : hostName(hostname);
  }
  const host = hostOf(input);
  const options = args[index + 1] && unwrapExpression(args[index + 1]);
  // No options, or a callback, leaves the URL's host; options that aren't written out could replace it.
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options)) return undefined;
  if (redirects(options, REDIRECTING_OPTIONS) || agentRedirects(options)) return undefined;
  const hostname = propertyValue(options, "hostname");
  return hostname === "absent" ? host : hostname === "unknown" ? undefined : hostName(hostname);
}

// What a socket's options can connect to instead of a host: a local socket, or an open one.
const SOCKET_REDIRECTS = ["path", "socket", ...REDIRECTING_OPTIONS];

/**
 * Where Node's net.connect and tls.connect connect: an options object's `host` (its `hostname`
 * is ignored, and a `path` is a local socket), or `connect(port, host)`. tls.connect also takes
 * `connect(port, host, options)` and merges the options over the host, so their `host` wins;
 * net ignores them. Options that set (or may set) a different host leave it unknown either way.
 */
export function nodeSocketHost(args: readonly Node[], index: number): string | undefined {
  const first = args[index] && unwrapExpression(args[index]);
  if (!first) return undefined;
  if (Node.isObjectLiteralExpression(first)) {
    return redirects(first, SOCKET_REDIRECTS) ? undefined : optionHost(first, "host");
  }
  const type = first.getType();
  if (!type.isNumber() && !type.isNumberLiteral()) return undefined; // a socket path, or options that can't be read
  const written = args[index + 1];
  const host = written && !isCallback(unwrapExpression(written)) ? hostName(written) : undefined;
  const options = args[index + 2] && unwrapExpression(args[index + 2]);
  // A callback (`connect(port, host, onConnect)`) isn't options.
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options) || redirects(options, SOCKET_REDIRECTS)) return undefined;
  return sameHost(options, host);
}

/**
 * Where Node's http2.connect(authority, options) connects: the authority's host, unless the
 * options set another. Node passes them on to net.connect or tls.connect, where their `host`
 * wins over the authority's, and a `path`, `socket`, `lookup`, or `createConnection` goes
 * somewhere else. Options that aren't written out could do any of that.
 */
export function nodeSessionHost(args: readonly Node[], index: number): string | undefined {
  const host = hostOf(args[index]);
  const options = args[index + 1] && unwrapExpression(args[index + 1]);
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options) || redirects(options, SOCKET_REDIRECTS)) return undefined;
  return sameHost(options, host);
}

/** `host`, if options merged over it leave it: they don't set `host`, or set the same one. */
function sameHost(options: ObjectLiteralExpression, host: string | undefined): string | undefined {
  const value = propertyValue(options, "host");
  if (value === "absent") return host;
  return value !== "unknown" && hostName(value) === host ? host : undefined;
}

/** A function given where options could be: a callback. */
function isCallback(node: Node): boolean {
  return node.getType().getCallSignatures().length > 0;
}

/**
 * Whether an http(s) request's `agent` option could connect somewhere other than its host. An
 * agent makes the connection, so only none (`false`, `undefined`, or absent) or a written-out
 * `new http.Agent({...})` / `new https.Agent({...})` without a spread or a redirecting option
 * leaves the host as written; any other agent (a variable, a subclass) could have its own
 * `lookup` or `createConnection`.
 */
function agentRedirects(options: ObjectLiteralExpression): boolean {
  const agent = propertyValue(options, "agent");
  if (agent === "absent") return false;
  if (agent === "unknown") return true;
  const value = Node.isShorthandPropertyAssignment(agent) ? agent : unwrapExpression(agent);
  if (value.getKind() === SyntaxKind.FalseKeyword || (Node.isIdentifier(value) && value.getText() === "undefined")) return false;
  const construct = agentConstruction(value);
  if (!construct) return true;
  const [config] = construct.getArguments();
  const literal = config && unwrapExpression(config);
  return literal !== undefined && (!Node.isObjectLiteralExpression(literal) || redirects(literal, REDIRECTING_OPTIONS));
}

/**
 * The `new http.Agent(...)` or `new https.Agent(...)` an agent option is: written in place, or
 * held by a `const` the program never changes (`const agent = new https.Agent({ keepAlive: true })`;
 * see isWritten). Undefined for anything else, a subclass included.
 */
function agentConstruction(value: Node): NewExpression | undefined {
  let construct = value;
  if (Node.isIdentifier(value) || Node.isShorthandPropertyAssignment(value)) {
    // In `{ agent }`, the name is also the value.
    const declaration = (Node.isShorthandPropertyAssignment(value) ? value.getValueSymbol() : value.getSymbol())?.getDeclarations()[0];
    const name = Node.isVariableDeclaration(declaration) && isConst(declaration) ? declaration.getNameNode() : undefined;
    const initializer = declaration && Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
    if (!Node.isIdentifier(name) || !initializer || isWritten(name)) return undefined;
    construct = unwrapExpression(initializer);
  }
  return Node.isNewExpression(construct) && isNodeAgent(construct) ? construct : undefined;
}

/** `new http.Agent(...)` or `new https.Agent(...)`: Node's own agent class, not a subclass. */
function isNodeAgent(construct: NewExpression): boolean {
  const declarations = construct.getType().getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => {
    if (!Node.isClassDeclaration(d) || d.getName() !== "Agent") return false;
    const module = d.getFirstAncestor((a) => Node.isModuleDeclaration(a) && Node.isStringLiteral(a.getNameNode()));
    return Node.isModuleDeclaration(module) && /^(node:)?https?$/.test(module.getNameNode().getText().slice(1, -1));
  });
}

/** Whether an options object sets, or may set, any of `keys`. */
function redirects(options: ObjectLiteralExpression, keys: readonly string[]): boolean {
  return keys.some((key) => propertyValue(options, key) !== "absent");
}

/** The literal host an option names; undefined if it's not set, or can't be read. */
function optionHost(options: ObjectLiteralExpression, key: string): string | undefined {
  const value = propertyValue(options, key);
  return value === "absent" || value === "unknown" ? undefined : hostName(value);
}

/** A literal host name, without a port (`host: "internal.example:8080"`), in lower case. */
function hostName(value: Node): string | undefined {
  return literalString(value)?.replace(/:\d+$/, "").toLowerCase() || undefined;
}

/** The global `URL` class, not a local one with the same name. */
function isGlobalUrl(expression: Node): boolean {
  if (!Node.isIdentifier(expression) || expression.getText() !== "URL") return false;
  const declarations = expression.getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile());
}
