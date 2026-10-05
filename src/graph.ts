// The call graph between units, and propagation of capabilities along it.
//
// An edge is anything that can make one unit's code run another's:
//   - a reference, not only a call: passing `helper` to `map` or `setTimeout`
//     lets it run (references in type positions, imports, and exports don't count);
//   - the declaration a call resolves to, which covers `super()`, literal
//     computed keys (`api["ping"]()`), and calls through const aliases;
//   - every implementation a call through an interface or base class may reach;
//   - every member a computed key could select (`handlers[kind]()`);
//   - a class's implicit constructor running its base constructor;
//   - importing a module, which runs its top-level code;
//   - a function handing a call an object of functions (`app.route({ handler() {...} })`,
//     or a const holding one): the callee can call any of them, like a function passed to it;
//   - a decorator, which runs where the class is defined (a member's is charged to the member).

import { Node, SyntaxKind, type Identifier, type SourceFile, type Type } from "ts-morph";
import type { AdapterIndex } from "./adapters.js";
import { UNVERIFIABLE, formatCapability, type Capability } from "./capability.js";
import { classifyComputedCall, computedCallee } from "./detect/computed.js";
import { loadOf, loadTarget } from "./detect/modules.js";
import { callText, literalString, resolveAlias, resolvedDeclaration, unwrapExpression, type CallLike } from "./detect/shared.js";
import { descendantsOfKind } from "./walk.js";
import type { Hierarchy } from "./dispatch.js";
import {
  constructorUnitNode,
  enclosingUnitNode,
  objectsHandedToCalls,
  unitNodeForDeclaration,
  unitNodeForSymbol,
  unitNodesForSymbol,
  type Unit,
  type Use,
} from "./units.js";

export interface Edge {
  from: Unit;
  to: Unit;
  /** The call or expression that reaches `to`, as written. */
  call: string;
  line: number;
  column: number;
}

export interface GraphContext {
  unitOf: (node: Node) => Unit | undefined;
  /** A file's units that code outside it can reach: its top level, and what it exports. */
  exportedUnits: (file: SourceFile) => readonly Unit[];
  hierarchy: Hierarchy;
  adapters: AdapterIndex;
}

export function collectEdges(sourceFile: SourceFile, ctx: GraphContext): Edge[] {
  const edges: Edge[] = [];
  const add = (fromNode: Node, target: Node | undefined, site: Node, text: string) => {
    const from = ctx.unitOf(enclosingUnitNode(fromNode));
    const to = target && ctx.unitOf(target);
    if (!from || !to) return;
    const { line, column } = sourceFile.getLineAndColumnAtPos(site.getStart());
    edges.push({ from, to, call: text, line, column });
  };
  const addFromModule = (target: Node | undefined, site: Node) => {
    const from = ctx.unitOf(sourceFile);
    const to = target && ctx.unitOf(target);
    if (!from || !to) return;
    const { line, column } = sourceFile.getLineAndColumnAtPos(site.getStart());
    edges.push({ from, to, call: site.getText().replace(/\s+/g, " "), line, column });
  };

  // References.
  for (const id of descendantsOfKind(sourceFile, SyntaxKind.Identifier)) {
    const symbol = referencedSymbol(id);
    if (!symbol) continue;
    const site = referenceSite(id);
    const text = Node.isCallExpression(site) || Node.isNewExpression(site) ? callText(site) : site.getText();
    const resolved = resolveAlias(symbol);
    // All of the symbol's units: `b.value = 2` runs the setter, not the getter that shares its name.
    for (const target of unitNodesForSymbol(resolved)) add(id, target, site, text);
    // A member read through an interface or base class (`s.url`, `urls.map(s.send)`,
    // `s.send.call(...)`) may be any implementation's.
    for (const d of resolved.getDeclarations()) for (const impl of ctx.hierarchy.implementations(d)) add(id, impl, site, text);
  }

  // An object of functions a function hands to a call: `app.route({ url, handler(q) {...} })`,
  // or a const holding one, `app.use(routes)`. (Handed out by the file's top-level code,
  // they're entry points instead; see units.ts.)
  for (const { call, members } of objectsHandedToCalls(sourceFile)) {
    if (Node.isSourceFile(enclosingUnitNode(call))) continue;
    for (const member of members) add(call, member, call, callText(call));
  }

  // Property reads that run getters without an `a.b`: `const { g } = b`, `b["g"]`.
  const addMembers = (from: Node, type: Type, names: (name: string) => boolean, text: string) => {
    for (const property of type.getProperties()) {
      if (!names(property.getName())) continue;
      for (const d of property.getDeclarations()) {
        add(from, unitNodeForDeclaration(d), from, text);
        for (const impl of ctx.hierarchy.implementations(d)) add(from, impl, from, text);
      }
    }
  };
  for (const element of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const pattern = element.getParent();
    if (!Node.isObjectBindingPattern(pattern)) continue;
    // `...rest` copies every property, running every getter.
    const name = element.getDotDotDotToken() ? undefined : (element.getPropertyNameNode()?.getText() ?? element.getName());
    addMembers(element, pattern.getType(), (n) => name === undefined || n === name, element.getText());
  }
  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const key = literalString(access.getArgumentExpression());
    if (key !== undefined) addMembers(access, access.getExpression().getType(), (n) => n === key, access.getText());
  }

  // Methods the language calls implicitly.
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    addMembers(node, node.getExpression().getType(), (n) => n === "then", node.getText().slice(0, 60));
  }
  const toPrimitive = (n: string) => n === "toString" || n === "valueOf" || n.startsWith("__@toPrimitive");
  for (const template of sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    for (const span of template.getTemplateSpans()) addMembers(span, span.getExpression().getType(), toPrimitive, template.getText().slice(0, 60));
  }
  for (const binary of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (binary.getOperatorToken().getKind() !== SyntaxKind.PlusToken) continue;
    const [left, right] = [binary.getLeft(), binary.getRight()];
    const text = binary.getText().slice(0, 60);
    if (isStringType(left.getType())) addMembers(binary, right.getType(), toPrimitive, text);
    if (isStringType(right.getType())) addMembers(binary, left.getType(), toPrimitive, text);
  }
  const iterator = (n: string) => n.startsWith("__@iterator") || n.startsWith("__@asyncIterator");
  for (const loop of sourceFile.getDescendantsOfKind(SyntaxKind.ForOfStatement)) {
    addMembers(loop, loop.getExpression().getType(), iterator, `for (... of ${loop.getExpression().getText()})`);
  }
  for (const spread of sourceFile.getDescendantsOfKind(SyntaxKind.SpreadElement)) {
    addMembers(spread, spread.getExpression().getType(), iterator, spread.getText());
  }
  for (const pattern of sourceFile.getDescendantsOfKind(SyntaxKind.ArrayBindingPattern)) {
    addMembers(pattern, pattern.getType(), iterator, pattern.getText());
  }

  // Calls: the resolved declaration, dispatch to implementations, computed members.
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const call: CallLike = node;
    const text = callText(call);

    // require(x) and import(x) run the module's top level. When TypeScript types the result,
    // calls on it resolve; when it's `any`, any of the module's exports could be called.
    const load = loadOf(call);
    if (load) {
      const [argument] = load.call.getArguments();
      const literal = argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) ? moduleOf(argument) : undefined;
      const target = literal ? undefined : loadTarget(load, ctx.adapters);
      const file = literal ?? (target?.kind === "file" ? target.file : undefined);
      add(call, file, call, text);
      if (load.untyped && file && Node.isSourceFile(file)) for (const unit of ctx.exportedUnits(file)) add(call, unit.node, call, text);
      return;
    }

    // super(...) runs the base constructor, explicit or implicit (an implicit one resolves to no declaration).
    if (Node.isCallExpression(call) && call.getExpression().getKind() === SyntaxKind.SuperKeyword) {
      const cls = call.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a));
      const base = cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) ? cls.getBaseClass() : undefined;
      if (base) add(call, constructorUnitNode(base), call, text);
    }

    const declaration = resolvedDeclaration(call);
    if (declaration) {
      add(call, unitNodeForDeclaration(declaration), call, text);
      for (const impl of ctx.hierarchy.implementations(declaration)) add(call, impl, call, text);
    }

    const computed = computedCallee(call);
    const target = computed && classifyComputedCall(computed, ctx.adapters);
    if (target?.kind === "members") {
      for (const member of target.members) {
        for (const d of member.getDeclarations()) {
          add(call, unitNodeForDeclaration(d) ?? valueUnit(d), call, text);
          for (const impl of ctx.hierarchy.implementations(d)) add(call, impl, call, text);
        }
      }
    }
  });

  // An implicit constructor runs the base class's constructor.
  for (const cls of [...sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration), ...sourceFile.getDescendantsOfKind(SyntaxKind.ClassExpression)]) {
    const base = cls.getBaseClass();
    if (!base || constructorUnitNode(cls) !== cls) continue;
    const from = ctx.unitOf(cls);
    const to = ctx.unitOf(constructorUnitNode(base));
    if (!from || !to) continue;
    const { line, column } = sourceFile.getLineAndColumnAtPos(cls.getStart());
    edges.push({ from, to, call: `extends ${base.getName() ?? "base class"}`, line, column });
  }

  // Imports and re-exports run the target module's top level, and so does `import x = require("y")`.
  for (const decl of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
    if (decl.isTypeOnly()) continue;
    addFromModule(decl.getModuleSpecifierSourceFile(), decl);
  }
  for (const decl of descendantsOfKind(sourceFile, SyntaxKind.ImportEqualsDeclaration)) {
    if (!decl.isTypeOnly() && Node.isExternalModuleReference(decl.getModuleReference())) addFromModule(decl.getExternalModuleReferenceSourceFile(), decl);
  }
  return edges;
}

/** The symbol an identifier refers to as a value, or undefined if it isn't a value reference. */
function referencedSymbol(id: Identifier) {
  const parent = id.getParent();
  // `{ helper }` passes the local `helper`.
  if (parent && Node.isShorthandPropertyAssignment(parent)) return isInValuePosition(id) ? parent.getValueSymbol() : undefined;
  return isValueReference(id) ? id.getSymbol() : undefined;
}

/** A property whose value names a function: `notify: sendAlert`. */
function valueUnit(declaration: Node): Node | undefined {
  if (!Node.isPropertyAssignment(declaration)) return undefined;
  const symbol = declaration.getInitializer()?.getSymbol();
  return symbol ? unitNodeForSymbol(resolveAlias(symbol)) : undefined;
}

/** The source file a module specifier (an import() argument) resolves to. */
function moduleOf(specifier: Node): Node | undefined {
  const declaration = specifier.getSymbol()?.getDeclarations()[0];
  return declaration && Node.isSourceFile(declaration) ? declaration : undefined;
}

function isInValuePosition(id: Identifier): boolean {
  for (const ancestor of id.getAncestors()) {
    if (Node.isTypeNode(ancestor) || Node.isJSDoc(ancestor)) return false;
    if (Node.isStatement(ancestor)) break;
  }
  return true;
}

function isValueReference(id: Identifier): boolean {
  const parent = id.getParent();
  // The name being declared is not a reference to it. (`a.f` also has a name node, but is a
  // reference, and so is a decorator's: `@logged` calls logged.)
  if (
    parent &&
    !Node.isPropertyAccessExpression(parent) &&
    !Node.isDecorator(parent) &&
    "getNameNode" in parent &&
    (parent as { getNameNode(): Node }).getNameNode() === id
  ) {
    return false;
  }
  for (const ancestor of id.getAncestors()) {
    if (Node.isTypeNode(ancestor) || Node.isJSDoc(ancestor) || Node.isImportDeclaration(ancestor) || Node.isExportDeclaration(ancestor)) {
      return false;
    }
    // `export default handler` exports it (see units.ts) without running it; in
    // `export default withAuth(handler)`, it's handed to a call like any other reference.
    if (Node.isExportAssignment(ancestor)) return unwrapExpression(ancestor.getExpression()) !== id;
    if (Node.isStatement(ancestor)) break;
  }
  return true;
}

/** The call a reference sits in: the call itself for `f()` / `a.f()`, the outer call for `map(f)`. */
function referenceSite(id: Identifier): Node {
  let node: Node = id;
  const parent = node.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) node = parent;
  const call = node.getParent();
  if (call && (Node.isCallExpression(call) || Node.isNewExpression(call))) return call;
  return id;
}

// --- propagation -------------------------------------------------------------

/** How a unit came to have a capability: used directly, or reached through an edge. */
export type Provenance = { capability: Capability; use: Use; edge?: undefined } | { capability: Capability; edge: Edge };

/** Every capability each unit can reach, keyed by its formatted form. */
export type Reach = Map<Unit, Map<string, Provenance>>;

export function propagate(units: Iterable<Unit>, edges: readonly Edge[]): Reach {
  const reach: Reach = new Map();
  for (const unit of units) {
    const own = new Map<string, Provenance>();
    for (const use of unit.uses) {
      const key = formatCapability(use.capability);
      if (!own.has(key)) own.set(key, { capability: use.capability, use });
    }
    reach.set(unit, own);
  }

  // Fixed point: recursion and cycles converge because keys are only ever added.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const into = reach.get(edge.from)!;
      for (const [key, p] of reach.get(edge.to)!) {
        if (into.has(key)) continue;
        // @perm-unsafe vouches for code the checker can't see; that doesn't fail its callers.
        if (key === UNVERIFIABLE && edge.to.own?.unsafe) continue;
        into.set(key, { capability: p.capability, edge });
        changed = true;
      }
    }
  }
  return reach;
}

/** The chain from `unit` to the call that uses `key`, e.g. ["b", "c", 'writeFileSync(...)']. */
export function pathTo(reach: Reach, unit: Unit, key: string): string[] {
  const path: string[] = [];
  let p = reach.get(unit)?.get(key);
  // Each provenance points at one recorded earlier, so this terminates.
  while (p?.edge) {
    path.push(p.edge.to.name);
    p = reach.get(p.edge.to)?.get(key);
  }
  if (p) path.push(p.use.call);
  return path;
}

/** The unit whose own code uses `key`: `unit` itself, or the last one on the chain from it. */
export function holderOf(reach: Reach, unit: Unit, key: string): Unit {
  let holder = unit;
  let p = reach.get(unit)?.get(key);
  while (p?.edge) {
    holder = p.edge.to;
    p = reach.get(holder)?.get(key);
  }
  return holder;
}

function isStringType(type: Type): boolean {
  return type.isString() || type.isStringLiteral() || type.isTemplateLiteral();
}
