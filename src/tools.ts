// Tools given to AI models. A function registered as a tool (MCP, the Vercel AI SDK,
// OpenAI Agents, LangChain, ...) runs when the model decides to call it, and the model
// does what its input says, so whoever controls that input can trigger it. Prompt
// injection then reaches whatever the tool reaches. This finds the registrations and
// their handlers, and works out what each handler reaches.

import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type NewExpression,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import { packageOf } from "./adapters.js";
import { UNVERIFIABLE, formatCapability } from "./capability.js";
import { literalString, resolveAlias, resolvedDeclaration, unwrapExpression } from "./detect/shared.js";
import type { Edge, Reach } from "./graph.js";
import { constructorUnitNode, enclosingUnitNode, isInNodeModules, unitNodeForDeclaration, unitNodesForSymbol, type Unit } from "./units.js";

export interface ToolRegistration {
  /** The tool's name as the model sees it, or `*` for a handler that serves every tool. */
  name: string;
  /** The package it's registered with, such as `ai` or `@modelcontextprotocol/sdk`. */
  framework: string;
  /** Where it's registered: the call or `new`, or the tool's entry in a `tools: { ... }` option. */
  site: Node;
  /** What runs when the model calls the tool: a function, or an object or class whose methods do. */
  handler: Node | undefined;
  /** The tool runs at the model provider (a hosted web search, say): no code here runs for it. */
  hosted?: boolean;
}

/**
 * Packages whose tool APIs hand a function to a model, by family: a package re-exports
 * others of its family (`@openai/agents` re-exports `tool` from `@openai/agents-core`, `ai`
 * re-exports it from `@ai-sdk/provider-utils`), and what's found is where it's declared.
 */
const FAMILIES: { matches: (pkg: string) => boolean; name?: string }[] = [
  { matches: (p) => p === "ai" || p.startsWith("@ai-sdk/"), name: "ai" },
  { matches: (p) => p === "@openai/agents" || p.startsWith("@openai/agents-"), name: "@openai/agents" },
  { matches: (p) => p.startsWith("@modelcontextprotocol/") },
  { matches: (p) => p.startsWith("@anthropic-ai/") },
  { matches: (p) => p === "langchain" || p.startsWith("@langchain/") },
  { matches: (p) => p === "llamaindex" || p.startsWith("@llamaindex/") },
  { matches: (p) => p.startsWith("@mastra/") },
];

/** The framework a package belongs to, as reported, or undefined if it isn't one. */
export function aiFramework(pkg: string | undefined): string | undefined {
  if (pkg === undefined) return undefined;
  const family = FAMILIES.find((f) => f.matches(pkg));
  return family && (family.name ?? pkg);
}

/** Functions that create or register a tool, including OpenAI Agents' built-in tools that run here. */
const TOOL_FUNCTION = /^(tool|registerTool|createTool|dynamicTool|betaTool|betaZodTool|zodTool|FunctionTool|shellTool|computerTool|applyPatchTool)$/;
/** Classes, and the types factories return (`ProviderDefinedTool`, `FunctionTool`), that are tools. */
const TOOL_CLASS = /Tool$/;
/** Where a tool definition keeps the function that runs. */
const FUNCTION_KEYS = new Set(["execute", "run", "func", "handler", "invoke", "callback", "fn"]);
/** Where a built-in tool keeps the object that runs it: OpenAI Agents' shellTool, computerTool, applyPatchTool. */
const IMPLEMENTATION_KEYS = new Set(["shell", "computer", "editor"]);

export function findTools(sourceFile: SourceFile): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) out.push(...registrationsAt(node));
  });
  return out;
}

function registrationsAt(call: CallExpression | NewExpression): ToolRegistration[] {
  // `new ShellTool()` of your own subclass of a framework's tool class.
  const subclass = Node.isNewExpression(call) ? toolSubclass(call) : undefined;
  if (subclass) return [subclass];

  const declaration = resolvedDeclaration(call);
  const framework = declaration && aiFramework(packageOf(declaration));
  if (!declaration || !framework) return [];
  const args = call.getArguments();
  const out = plainTools(args, framework);
  const name = calleeName(call, declaration);

  // MCP's low-level API: one handler serves every tool call.
  if (name === "setRequestHandler") {
    if (servesToolCalls(args[0])) out.push({ name: "*", framework, site: call, handler: lastFunction(args) });
    return out;
  }
  if (isToolFactory(call, name)) out.push({ name: toolName(call), framework, site: call, ...handlerOf(call) });
  return out;
}

/** The called function's or class's name, from its declaration, without a bundler's rename suffix. */
function calleeName(call: CallExpression | NewExpression, declaration: Node): string | undefined {
  return declaredName(call, declaration)?.replace(/\$\d+$/, "");
}

function declaredName(call: CallExpression | NewExpression, declaration: Node): string | undefined {
  if (Node.isNewExpression(call)) {
    const cls = Node.isConstructorDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration) ? declaration.getParent() : declaration;
    return cls && "getName" in cls ? (cls as { getName(): string | undefined }).getName() : undefined;
  }
  const named = Node.isFunctionTypeNode(declaration) || Node.isArrowFunction(declaration) ? declaration.getParent() : declaration;
  return named && "getName" in named ? (named as { getName(): string | undefined }).getName() : undefined;
}

/**
 * A call that makes a tool: by name (`tool`, `registerTool`, ...), a class named `...Tool`,
 * or a factory that returns a tool type, which covers provider tools such as
 * `anthropic.tools.bash_20250124(...)` and LlamaIndex's `FunctionTool.from(...)`.
 */
function isToolFactory(call: CallExpression | NewExpression, name: string | undefined): boolean {
  if (name !== undefined && (Node.isNewExpression(call) ? TOOL_CLASS : TOOL_FUNCTION).test(name)) return true;
  if (Node.isNewExpression(call)) return false;
  const type = call.getType();
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  return symbol !== undefined && TOOL_CLASS.test(symbol.getName()) && declaration !== undefined && aiFramework(packageOf(declaration)) !== undefined;
}

/**
 * MCP's request handler for tool calls: `CallToolRequestSchema` (version 1), compared by symbol
 * so a renamed import still counts, or the method name `"tools/call"` (version 2). A method
 * that can't be determined could be tool calls.
 */
function servesToolCalls(arg: Node | undefined): boolean {
  if (!arg) return false;
  const literal = literalString(arg);
  if (literal !== undefined) return literal === "tools/call";
  const target = Node.isPropertyAccessExpression(arg) ? arg.getNameNode() : arg;
  const symbol = target.getSymbol();
  if (!symbol) return true;
  const resolved = resolveAlias(symbol);
  const declaration = resolved.getDeclarations()[0];
  // A schema the SDK declares is known; anything else (a parameter, a variable) could be tool calls.
  if (declaration && aiFramework(packageOf(declaration)) !== undefined) return resolved.getName() === "CallToolRequestSchema";
  return true;
}

/**
 * The handler: the last function argument (MCP's callback, LangChain's `tool(func, ...)`,
 * LlamaIndex's `FunctionTool.from(fn, ...)`), else a definition's `execute`/`run`/`func`
 * function, or a built-in tool's `shell`/`computer`/`editor` object. A definition with no
 * handler written runs at the provider when its type has no place for one.
 */
function handlerOf(call: CallExpression | NewExpression): Pick<ToolRegistration, "handler" | "hosted"> {
  const args = call.getArguments();
  const fn = lastFunction(args);
  if (fn) return { handler: fn };
  for (const arg of args) {
    const handler = Node.isObjectLiteralExpression(arg) ? definitionHandler(arg) : undefined;
    if (handler) return { handler };
  }
  return mayTakeHandler(call) ? { handler: undefined } : { handler: undefined, hosted: true };
}

function lastFunction(args: readonly Node[]): Node | undefined {
  return [...args].reverse().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || a.getType().getCallSignatures().length > 0);
}

/** A definition's handler property. A property named like one that isn't a function (MCP's schema `{ run: "boolean" }`) isn't it. */
function definitionHandler(definition: ObjectLiteralExpression): Node | undefined {
  for (const p of definition.getProperties()) {
    if (Node.isSpreadAssignment(p)) continue;
    const key = p.getName();
    if (IMPLEMENTATION_KEYS.has(key)) return p;
    if (!FUNCTION_KEYS.has(key)) continue;
    if (Node.isMethodDeclaration(p)) return p;
    const value = Node.isPropertyAssignment(p) ? p.getInitializer() : Node.isShorthandPropertyAssignment(p) ? p.getNameNode() : undefined;
    if (value && value.getType().getCallSignatures().length > 0) return p;
  }
  return undefined;
}

/**
 * Whether a definition without a handler could still have run code here: when it was built
 * elsewhere (not an object literal, or spread from another object), or when its type has a
 * place for a handler (the AI SDK hands such calls back to the app, or to a sandbox).
 * Provider-run tools, such as a hosted web search, have none.
 */
function mayTakeHandler(call: CallExpression | NewExpression): boolean {
  for (const arg of call.getArguments()) {
    const type = arg.getType();
    if (!Node.isObjectLiteralExpression(arg)) {
      if (type.isObject() || type.isAny() || type.isUnknown()) return true;
    } else if (arg.getProperties().some((p) => Node.isSpreadAssignment(p))) {
      return true;
    }
  }
  const signature = call.getProject().getTypeChecker().getResolvedSignature(call);
  if (!signature) return true;
  return signature.getParameters().some((parameter) => {
    const type = parameter.getTypeAtLocation(call).getNonNullableType();
    return [...FUNCTION_KEYS, ...IMPLEMENTATION_KEYS].some((key) => {
      const property = type.getProperty(key);
      // `shell?: never` says a hosted tool takes no implementation.
      return property !== undefined && !property.getDeclarations().every((d) => Node.isPropertySignature(d) && d.getTypeNode()?.getText() === "never");
    });
  });
}

/** Tools written as plain objects in a `tools` option: `generateText({ tools: { shell: { execute } } })`. */
function plainTools(args: readonly Node[], framework: string): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  for (const arg of args) {
    const options = objectLiteralOf(arg);
    const property = options?.getProperty("tools");
    const value = property && (Node.isPropertyAssignment(property) ? property.getInitializer() : Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : undefined);
    if (!value) continue;
    const list = unwrapExpression(value);
    if (Node.isArrayLiteralExpression(list)) {
      for (const element of list.getElements()) {
        const definition = objectLiteralOf(element);
        if (definition && isDefinition(definition)) out.push({ name: nameProperty(definition) ?? "tool", framework, site: element, handler: definitionHandler(definition) });
      }
      continue;
    }
    for (const entry of objectLiteralOf(list)?.getProperties() ?? []) {
      if (!Node.isPropertyAssignment(entry) && !Node.isShorthandPropertyAssignment(entry)) continue;
      const definition = objectLiteralOf(Node.isPropertyAssignment(entry) ? entry.getInitializerOrThrow() : entry.getNameNode());
      if (definition && isDefinition(definition)) out.push({ name: entry.getName(), framework, site: entry, handler: definitionHandler(definition) });
    }
  }
  return out;
}

/** A plain object that defines a tool the framework runs: it has a handler key. Schema-only definitions (handled by the app) don't. */
function isDefinition(definition: ObjectLiteralExpression): boolean {
  return definition.getProperties().some((p) => !Node.isSpreadAssignment(p) && FUNCTION_KEYS.has(p.getName()));
}

/** An object literal, or a const that holds one (`const tools = {...}; generateText({ tools })`). */
function objectLiteralOf(node: Node | undefined, depth = 0): ObjectLiteralExpression | undefined {
  if (!node || depth > 4) return undefined;
  const n = unwrapExpression(node);
  if (Node.isObjectLiteralExpression(n)) return n;
  const parent = n.getParent();
  const symbol = parent && Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : Node.isIdentifier(n) ? n.getSymbol() : undefined;
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  return declaration && isConstVariable(declaration) ? objectLiteralOf(declaration.getInitializer(), depth + 1) : undefined;
}

/** `new ShellTool()` where ShellTool is your class extending a framework's tool class (LangChain's `StructuredTool`). */
function toolSubclass(call: NewExpression): ToolRegistration | undefined {
  const cls = classOf(call.getExpression());
  if (!cls || isThirdParty(cls)) return undefined;
  const chain = firstPartyChain(cls);
  const base = chain.at(-1)!.getBaseClass();
  const framework = base && aiFramework(packageOf(base));
  if (!base || !framework || !TOOL_CLASS.test(base.getName() ?? "")) return undefined;
  // LangChain runs `_call`; for other frameworks, any method could be what runs.
  const run = chain.flatMap((c) => c.getMethods()).find((m) => m.getName() === "_call" && m.hasBody());
  return { name: subclassToolName(chain) ?? cls.getName() ?? "tool", framework, site: call, handler: run ?? cls };
}

/** A tool class's `name = "..."` field, or the name its constructor passes to `super({ name })`. */
function subclassToolName(chain: readonly (ClassDeclaration | ClassExpression)[]): string | undefined {
  for (const c of chain) {
    const field = literalString(c.getProperty("name")?.getInitializer());
    if (field !== undefined) return field;
    for (const ctor of c.getConstructors()) {
      for (const call of ctor.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== SyntaxKind.SuperKeyword) continue;
        const name = call.getArguments().map((a) => (Node.isObjectLiteralExpression(a) ? nameProperty(a) : undefined)).find((n) => n !== undefined);
        if (name !== undefined) return name;
      }
    }
  }
  return undefined;
}

function classOf(expression: Node): ClassDeclaration | ClassExpression | undefined {
  const symbol = expression.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations().find((d) => Node.isClassDeclaration(d) || Node.isClassExpression(d));
  return declaration as ClassDeclaration | ClassExpression | undefined;
}

/** A class and its first-party base classes, nearest first. */
function firstPartyChain(cls: ClassDeclaration | ClassExpression): (ClassDeclaration | ClassExpression)[] {
  const chain = [cls];
  for (let base = cls.getBaseClass(); base && !isThirdParty(base) && !chain.includes(base); base = base.getBaseClass()) chain.push(base);
  return chain;
}

function isThirdParty(node: Node): boolean {
  return node.getSourceFile().isDeclarationFile() || isInNodeModules(node.getSourceFile());
}

function isConstVariable(node: Node): node is VariableDeclaration {
  return Node.isVariableDeclaration(node) && node.getVariableStatement()?.getDeclarationKind() === "const" && !isThirdParty(node);
}

/** The first string argument, else a `name` (or Mastra's `id`) property, else what the result is assigned to. */
function toolName(call: CallExpression | NewExpression): string {
  const args = call.getArguments();
  const literal = literalString(args[0]);
  if (literal !== undefined) return literal;
  for (const arg of args) {
    const value = Node.isObjectLiteralExpression(arg) ? nameProperty(arg) : undefined;
    if (value !== undefined) return value;
  }
  const holder = call.getParent();
  if (holder && (Node.isPropertyAssignment(holder) || Node.isVariableDeclaration(holder))) return holder.getName();
  return "tool";
}

function nameProperty(definition: ObjectLiteralExpression): string | undefined {
  for (const key of ["name", "id"]) {
    const p = definition.getProperty(key);
    const value = p && Node.isPropertyAssignment(p) ? literalString(p.getInitializer()) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

// --- what a handler reaches --------------------------------------------------

export interface ReachContext {
  units: ReadonlyMap<Node, Unit>;
  reach: Reach;
  edgesFrom: ReadonlyMap<Unit, readonly Edge[]>;
}

/**
 * What the model can trigger through a tool: everything its handler reaches. A handler
 * that's a unit (a named function, a method) reaches what that unit reaches. An inline
 * callback isn't a unit: its uses and calls are charged to the code around it, so those
 * inside its body count. An object or class reaches what its methods do. A handler that
 * can't be followed (a parameter, say) could be anything.
 */
export function handlerReach(tool: ToolRegistration, ctx: ReachContext): Set<string> {
  const out = new Set<string>();
  if (tool.hosted) return out;
  if (!tool.handler) return out.add(UNVERIFIABLE);
  valueReach(tool.handler, ctx, out, 0);
  // A built-in tool can be given a factory (`computer: () => new LocalComputer()`, or
  // `{ create }`): the framework then calls the methods of what it builds.
  const value = Node.isPropertyAssignment(tool.handler) && IMPLEMENTATION_KEYS.has(tool.handler.getName()) ? tool.handler.getInitializer() : undefined;
  if (value) productReach(value, ctx, out);
  return out;
}

function valueReach(node: Node, ctx: ReachContext, out: Set<string>, depth: number): void {
  if (depth > 8) {
    out.add(UNVERIFIABLE);
    return;
  }
  const add = (unitNode: Node | undefined) => {
    const unit = unitNode && ctx.units.get(unitNode);
    if (unit) for (const key of ctx.reach.get(unit)!.keys()) out.add(key);
    return unit !== undefined;
  };
  const n = unwrapExpression(node);

  // A class: everything in it, and in its own base classes, could be what the framework runs.
  if (Node.isClassDeclaration(n) || Node.isClassExpression(n)) {
    for (const c of firstPartyChain(n)) {
      add(constructorUnitNode(c));
      c.forEachDescendant((d) => void add(d));
    }
    return;
  }
  // A property of a definition: its value (or, for a function-valued property, the property itself).
  if (Node.isPropertyAssignment(n)) return add(n) ? undefined : valueReach(n.getInitializerOrThrow(), ctx, out, depth + 1);
  if (Node.isShorthandPropertyAssignment(n)) return valueReach(n.getNameNode(), ctx, out, depth + 1);
  if (add(n) || add(unitNodeForDeclaration(n))) return;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
    inline(n, ctx, out);
    return;
  }
  if (Node.isObjectLiteralExpression(n)) {
    for (const p of n.getProperties()) {
      if (Node.isSpreadAssignment(p)) out.add(UNVERIFIABLE);
      else if (Node.isMethodDeclaration(p) || Node.isGetAccessorDeclaration(p) || Node.isSetAccessorDeclaration(p)) add(p);
      // The framework calls the object's functions; its other values don't run.
      else if (p.getType().getCallSignatures().length > 0 || Node.isObjectLiteralExpression(valueOf(p))) valueReach(Node.isPropertyAssignment(p) ? p : p.getNameNode(), ctx, out, depth + 1);
    }
    return;
  }
  if (Node.isNewExpression(n)) {
    const cls = classOf(n.getExpression());
    if (cls && !isThirdParty(cls)) valueReach(cls, ctx, out, depth + 1);
    else inline(n, ctx, out);
    return;
  }
  if (Node.isIdentifier(n) || Node.isPropertyAccessExpression(n)) {
    const parent = n.getParent();
    const symbol = parent && Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === n ? parent.getValueSymbol() : n.getSymbol();
    const resolved = symbol && resolveAlias(symbol);
    const declaration = resolved?.getDeclarations()[0];
    if (!resolved || !declaration) {
      out.add(UNVERIFIABLE);
      return;
    }
    const targets = unitNodesForSymbol(resolved);
    if (targets.length > 0) targets.forEach(add);
    else if (isConstVariable(declaration) && declaration.getInitializer()) valueReach(declaration.getInitializer()!, ctx, out, depth + 1);
    else if (Node.isClassDeclaration(declaration) && !isThirdParty(declaration)) valueReach(declaration, ctx, out, depth + 1);
    // A library's function or object: what adapters say about the reference itself.
    else if (isThirdParty(declaration)) inline(n, ctx, out);
    else out.add(UNVERIFIABLE);
    return;
  }
  // Anything else (a call's result, a computed value) could be anything.
  out.add(UNVERIFIABLE);
}

/**
 * What the object a factory builds can reach, for a factory function or a `{ create }`
 * provider: the methods of its (awaited) return type. A method declared only by a library's
 * interface (the return type says `Computer`) has no implementation to follow.
 */
function productReach(value: Node, ctx: ReachContext, out: Set<string>): void {
  const type = value.getType();
  const create = type.getProperty("create")?.getTypeAtLocation(value);
  for (const signature of [...type.getCallSignatures(), ...(create?.getCallSignatures() ?? [])]) {
    let product = signature.getReturnType();
    if (product.getSymbol()?.getName() === "Promise") product = product.getTypeArguments()[0] ?? product;
    if (!product.isObject()) continue;
    for (const property of product.getProperties()) {
      if (property.getTypeAtLocation(value).getCallSignatures().length === 0) continue;
      const implementations = property.getDeclarations().map(unitNodeForDeclaration).filter((n): n is Node => n !== undefined);
      if (implementations.length === 0) out.add(UNVERIFIABLE);
      for (const n of implementations) {
        const unit = ctx.units.get(n);
        if (unit) for (const key of ctx.reach.get(unit)!.keys()) out.add(key);
      }
    }
  }
}

function valueOf(p: Node): Node | undefined {
  return Node.isPropertyAssignment(p) ? p.getInitializer() && unwrapExpression(p.getInitializer()!) : undefined;
}

/** What code inside `node` reaches when it belongs to the unit around it: its uses, and the calls it makes. */
function inline(node: Node, ctx: ReachContext, out: Set<string>): void {
  const unit = ctx.units.get(enclosingUnitNode(node));
  if (!unit) return;
  const sf = node.getSourceFile();
  const start = sf.getLineAndColumnAtPos(node.getStart());
  const end = sf.getLineAndColumnAtPos(node.getEnd());
  const inside = (p: { line: number; column: number }) =>
    (p.line > start.line || (p.line === start.line && p.column >= start.column)) && (p.line < end.line || (p.line === end.line && p.column <= end.column));
  for (const use of unit.uses) if (inside(use)) out.add(formatCapability(use.capability));
  for (const edge of ctx.edgesFrom.get(unit) ?? []) if (inside(edge)) for (const key of ctx.reach.get(edge.to)!.keys()) out.add(key);
}
