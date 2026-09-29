// The call graph between units, and propagation of capabilities along it.
//
// An edge is any reference from one unit's code to another unit, not only a
// call: passing `helper` to `map` or `setTimeout` lets it run, so it counts.
// References in type positions, imports, and exports do not.

import { Node, SyntaxKind, type Identifier, type SourceFile } from "ts-morph";
import { formatCapability, type Capability } from "./capability.js";
import { callText, resolveAlias } from "./detect/shared.js";
import { enclosingUnitNode, unitNodeForSymbol, type Unit, type Use } from "./units.js";

export interface Edge {
  from: Unit;
  to: Unit;
  /** The call or expression that reaches `to`, as written. */
  call: string;
  line: number;
  column: number;
}

export function collectEdges(sourceFile: SourceFile, unitOf: (node: Node) => Unit | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!isValueReference(id)) continue;
    const symbol = id.getSymbol();
    const targetNode = symbol && unitNodeForSymbol(resolveAlias(symbol));
    const to = targetNode && unitOf(targetNode);
    const from = unitOf(enclosingUnitNode(id));
    if (!to || !from) continue;

    const site = referenceSite(id);
    const { line, column } = sourceFile.getLineAndColumnAtPos(site.getStart());
    edges.push({ from, to, call: Node.isCallExpression(site) || Node.isNewExpression(site) ? callText(site) : site.getText(), line, column });
  }
  return edges;
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
