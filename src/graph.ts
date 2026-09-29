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
//   - importing a module, which runs its top-level code.

import { Node, SyntaxKind, type Identifier, type SourceFile } from "ts-morph";
import type { AdapterIndex } from "./adapters.js";
import { UNVERIFIABLE, formatCapability, type Capability } from "./capability.js";
import { classifyComputedCall, computedCallee } from "./detect/computed.js";
import { callText, literalString, resolveAlias, resolvedDeclaration, type CallLike } from "./detect/shared.js";
import type { Hierarchy } from "./dispatch.js";
import { constructorUnitNode, enclosingUnitNode, unitNodeForDeclaration, unitNodeForSymbol, type Unit, type Use } from "./units.js";

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
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const symbol = referencedSymbol(id);
    if (!symbol) continue;
    const site = referenceSite(id);
    const text = Node.isCallExpression(site) || Node.isNewExpression(site) ? callText(site) : site.getText();
    add(id, unitNodeForSymbol(resolveAlias(symbol)), site, text);
  }

  // Calls: the resolved declaration, dispatch to implementations, computed members.
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const call: CallLike = node;
    const text = callText(call);

    if (Node.isCallExpression(call) && call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
      const target = literalString(call.getArguments()[0]) === undefined ? undefined : moduleOf(call.getArguments()[0]!);
      add(call, target, call, text);
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

  // Imports and re-exports run the target module's top level.
  for (const decl of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
    if (decl.isTypeOnly()) continue;
    addFromModule(decl.getModuleSpecifierSourceFile(), decl);
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
  // The name being declared is not a reference to it. (`a.f` also has a name node, but is a reference.)
  if (
    parent &&
    !Node.isPropertyAccessExpression(parent) &&
    "getNameNode" in parent &&
    (parent as { getNameNode(): Node }).getNameNode() === id
  ) {
    return false;
  }
  for (const ancestor of id.getAncestors()) {
    if (
      Node.isTypeNode(ancestor) ||
      Node.isJSDoc(ancestor) ||
      Node.isImportDeclaration(ancestor) ||
      Node.isExportDeclaration(ancestor) ||
      Node.isExportAssignment(ancestor)
    ) {
      return false;
    }
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
