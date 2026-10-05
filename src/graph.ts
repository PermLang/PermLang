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

import { Node, SyntaxKind, ts, VariableDeclarationKind, type ClassDeclaration, type ClassExpression, type Identifier, type SourceFile, type Type } from "ts-morph";
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

  // Property reads that run getters without an `a.b`: `const { g } = b`, `({ g } = b)`, `b["g"]`, `{ ...b }`.
  const addMembers = (from: Node, type: Type, names: (name: string) => boolean, text: string, gettersOnly = false) => {
    for (const property of type.getProperties()) {
      if (!names(property.getName())) continue;
      for (const d of property.getDeclarations()) {
        for (const target of [unitNodeForDeclaration(d), ...ctx.hierarchy.implementations(d)]) {
          if (!gettersOnly || (target && Node.isGetAccessorDeclaration(target))) add(from, target, from, text);
        }
      }
    }
  };
  const named = (name: string | undefined) => (n: string) => name === undefined || n === name;
  for (const element of descendantsOfKind(sourceFile, SyntaxKind.BindingElement)) {
    const pattern = element.getParent();
    if (!Node.isObjectBindingPattern(pattern)) continue;
    // `...rest` copies every property, running every getter; so may a computed key.
    const name = element.getDotDotDotToken() ? undefined : propertyKey(element.getPropertyNameNode() ?? element.getNameNode());
    addMembers(element, pattern.getType(), named(name), element.getText());
  }
  for (const access of descendantsOfKind(sourceFile, SyntaxKind.ElementAccessExpression)) {
    const key = literalString(access.getArgumentExpression());
    if (key !== undefined) addMembers(access, access.getExpression().getType(), (n) => n === key, access.getText());
  }
  // Copying an object runs its getters: `{ ...b }`.
  for (const spread of descendantsOfKind(sourceFile, SyntaxKind.SpreadAssignment)) {
    if (isAssignmentTarget(spread.getParentOrThrow())) continue;
    addMembers(spread, spread.getExpression().getType(), named(undefined), spread.getText(), true);
  }

  // Methods the language calls implicitly.
  const iterator = (n: string) => n.startsWith("__@iterator") || n.startsWith("__@asyncIterator");
  for (const node of descendantsOfKind(sourceFile, SyntaxKind.AwaitExpression)) {
    addMembers(node, node.getExpression().getType(), (n) => n === "then", node.getText().slice(0, 60));
  }
  const toPrimitive = (n: string) => n === "toString" || n === "valueOf" || n.startsWith("__@toPrimitive");
  for (const template of descendantsOfKind(sourceFile, SyntaxKind.TemplateExpression)) {
    for (const span of template.getTemplateSpans()) addMembers(span, span.getExpression().getType(), toPrimitive, template.getText().slice(0, 60));
  }
  // Arithmetic, comparisons, `+`, and `==` convert objects to primitives: `o * 2`, `"x" + o`, `s += o`.
  const convert = (node: Node, operand: Node) => {
    const type = operand.getType();
    // (A primitive's methods are all in the standard library: skip looking them up.)
    if ((type.getFlags() & PRIMITIVE) === 0) addMembers(node, type, toPrimitive, node.getText().slice(0, 60));
  };
  for (const binary of descendantsOfKind(sourceFile, SyntaxKind.BinaryExpression)) {
    const operator = binary.getOperatorToken().getKind();
    if (CONVERTING.has(operator)) for (const operand of [binary.getLeft(), binary.getRight()]) convert(binary, operand);
    // `x instanceof K` runs K's static [Symbol.hasInstance].
    if (operator === SyntaxKind.InstanceOfKeyword) {
      addMembers(binary, binary.getRight().getType(), (n) => n.startsWith("__@hasInstance"), binary.getText().slice(0, 60));
    }
    // `({ g } = b)` reads b.g, like `const { g } = b`; `[x] = b` iterates b.
    const target = binary.getLeft();
    if (operator === SyntaxKind.EqualsToken && Node.isObjectLiteralExpression(target)) {
      for (const p of target.getProperties()) {
        const name = Node.isSpreadAssignment(p) ? undefined : propertyKey(p.getNameNode());
        addMembers(p, binary.getRight().getType(), named(name), p.getText());
      }
    }
    if (operator === SyntaxKind.EqualsToken && Node.isArrayLiteralExpression(target)) {
      addMembers(binary, binary.getRight().getType(), iterator, binary.getText().slice(0, 60));
    }
  }
  for (const unary of [...descendantsOfKind(sourceFile, SyntaxKind.PrefixUnaryExpression), ...descendantsOfKind(sourceFile, SyntaxKind.PostfixUnaryExpression)]) {
    if (unary.getOperatorToken() !== SyntaxKind.ExclamationToken) convert(unary, unary.getOperand());
  }
  for (const loop of descendantsOfKind(sourceFile, SyntaxKind.ForOfStatement)) {
    addMembers(loop, loop.getExpression().getType(), iterator, `for (... of ${loop.getExpression().getText()})`);
  }
  for (const spread of descendantsOfKind(sourceFile, SyntaxKind.SpreadElement)) {
    addMembers(spread, spread.getExpression().getType(), iterator, spread.getText());
  }
  for (const pattern of descendantsOfKind(sourceFile, SyntaxKind.ArrayBindingPattern)) {
    addMembers(pattern, pattern.getType(), iterator, pattern.getText());
  }
  for (const yieldStar of descendantsOfKind(sourceFile, SyntaxKind.YieldExpression)) {
    const delegated = yieldStar.getExpression();
    if (yieldStar.getAsteriskToken() && delegated) addMembers(yieldStar, delegated.getType(), iterator, yieldStar.getText().slice(0, 60));
  }
  // `using r = ...` runs r[Symbol.dispose]() when the block ends; `await using`, [Symbol.asyncDispose]().
  for (const list of descendantsOfKind(sourceFile, SyntaxKind.VariableDeclarationList)) {
    const kind = list.getDeclarationKind();
    if (kind !== VariableDeclarationKind.Using && kind !== VariableDeclarationKind.AwaitUsing) continue;
    const disposes = (n: string) => n.startsWith("__@dispose") || (kind === VariableDeclarationKind.AwaitUsing && n.startsWith("__@asyncDispose"));
    for (const declaration of list.getDeclarations()) addMembers(declaration, declaration.getType(), disposes, declaration.getText().slice(0, 60));
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
      for (const base of cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) ? baseClasses(cls) : []) {
        add(call, constructorUnitNode(base), call, text);
      }
    }
    // `new K()` where K holds a class built by an expression (`const K = make()`, a mixin):
    // its type names the class, even with no declaration to resolve to.
    if (Node.isNewExpression(call)) for (const cls of constructedClasses(call.getExpression())) add(call, constructorUnitNode(cls), call, text);

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

  // An implicit constructor runs the base class's constructor (`extends Base`, or a mixin's class).
  for (const cls of [...descendantsOfKind(sourceFile, SyntaxKind.ClassDeclaration), ...descendantsOfKind(sourceFile, SyntaxKind.ClassExpression)]) {
    if (constructorUnitNode(cls) !== cls) continue;
    const from = ctx.unitOf(cls);
    const { line, column } = sourceFile.getLineAndColumnAtPos(cls.getStart());
    for (const base of baseClasses(cls)) {
      const to = ctx.unitOf(constructorUnitNode(base));
      if (from && to) edges.push({ from, to, call: `extends ${cls.getExtends()!.getExpression().getText().replace(/\s+/g, " ").slice(0, 60)}`, line, column });
    }
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

/** The classes a value of this expression's type constructs: a class, or the classes a mixin combines. */
function constructedClasses(expression: Node): (ClassDeclaration | ClassExpression)[] {
  const type = expression.getType();
  const parts = type.isIntersection() ? type.getIntersectionTypes() : type.isUnion() ? type.getUnionTypes() : [type];
  return parts.flatMap((t) => (t.getSymbol()?.getDeclarations() ?? []).filter((d) => Node.isClassDeclaration(d) || Node.isClassExpression(d)));
}

/** The classes a class extends: `extends Base`, or what `extends Mixin(Base)` returns. */
function baseClasses(cls: ClassDeclaration | ClassExpression): (ClassDeclaration | ClassExpression)[] {
  const heritage = cls.getExtends()?.getExpression();
  return heritage ? constructedClasses(heritage) : [];
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

const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

// Operators that convert their operands to primitives (`===`, `&&`, `??` and the like don't).
const CONVERTING = new Set([
  SyntaxKind.PlusToken, SyntaxKind.MinusToken, SyntaxKind.AsteriskToken, SyntaxKind.SlashToken, SyntaxKind.PercentToken,
  SyntaxKind.AsteriskAsteriskToken, SyntaxKind.LessThanToken, SyntaxKind.GreaterThanToken, SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken, SyntaxKind.AmpersandToken,
  SyntaxKind.BarToken, SyntaxKind.CaretToken, SyntaxKind.LessThanLessThanToken, SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken, SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken, SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AmpersandEqualsToken, SyntaxKind.BarEqualsToken, SyntaxKind.CaretEqualsToken, SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken, SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/** The property a destructuring key names: `data`, `"data"`, `[KEY]` with a literal KEY; undefined when it can't be known. */
function propertyKey(name: Node): string | undefined {
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name) || Node.isNumericLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) return name.getLiteralText();
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return undefined;
}

/** The left side of `=`: `({ a } = b)` destructures rather than builds an object. */
function isAssignmentTarget(node: Node): boolean {
  const parent = node.getParent();
  return parent !== undefined && Node.isBinaryExpression(parent) && parent.getLeft() === node && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}
