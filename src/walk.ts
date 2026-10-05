// Walking a syntax tree without recursion.
//
// ts-morph's own traversals (forEachDescendant, getDescendantsOfKind) recurse once per
// level of nesting, so a valid but deeply nested expression, such as a 3,000-term string
// concatenation, overflows the stack. These keep their own stack instead, and visit nodes
// parents first, so wrapping a node never has to wrap its ancestors recursively either.

import { Node, type KindToNodeMappings, type SyntaxKind } from "ts-morph";

/** Calls `visit` on every node under `root` (not `root` itself), in source order, parents first. */
export function forEachDescendant(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [];
  pushChildren(root, stack);
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    pushChildren(node, stack);
  }
}

/** Every node of `kind` under `root`, in source order. */
export function descendantsOfKind<K extends SyntaxKind>(root: Node, kind: K): KindToNodeMappings[K][] {
  const out: KindToNodeMappings[K][] = [];
  forEachDescendant(root, (node) => {
    if (node.getKind() === kind) out.push(node as KindToNodeMappings[K]);
  });
  return out;
}

function pushChildren(node: Node, stack: Node[]): void {
  const children: Node[] = [];
  // A callback that returns a value stops forEachChild, so this one returns nothing.
  node.forEachChild((child) => {
    children.push(child);
  });
  for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
}
