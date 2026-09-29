// Dynamic dispatch. A call through an interface, a base class, or a structural
// type may run any implementation of that member. This charges the caller with
// every first-party implementation:
//   - methods and function-valued fields of classes that extend or implement the
//     declaring type (directly or through other classes and interfaces);
//   - members of object literals whose contextual type is the declaring type
//     (`const n: Notifier = { notify: ... }`, or an argument passed to a
//     parameter of that type).
// Functions attached after the fact (`obj.m = fn`) are not found: a known limit.

import { Node, SyntaxKind, type ClassDeclaration, type ClassExpression, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import { resolveAlias } from "./detect/shared.js";
import { unitNodeForDeclaration, unitNodeForSymbol } from "./units.js";

type ClassNode = ClassDeclaration | ClassExpression;

export class Hierarchy {
  private readonly classes: { cls: ClassNode; ancestors: Set<Node> }[] = [];
  private readonly literals = new Map<Node, ObjectLiteralExpression[]>();

  constructor(sourceFiles: readonly SourceFile[]) {
    for (const sf of sourceFiles) {
      for (const cls of [...sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration), ...sf.getDescendantsOfKind(SyntaxKind.ClassExpression)]) {
        this.classes.push({ cls, ancestors: classAncestors(cls) });
      }
      for (const literal of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        for (const type of contextualTypeDeclarations(literal)) {
          for (const t of [type, ...typeAncestors(type)]) this.literals.set(t, [...(this.literals.get(t) ?? []), literal]);
        }
      }
    }
  }

  /** Unit nodes that a call to `member` (as declared) might run, beyond the declaration itself. */
  implementations(member: Node): Node[] {
    const container = member.getParent();
    const name = memberName(member);
    if (!container || name === undefined || container.getSourceFile().isDeclarationFile()) return [];

    const out: Node[] = [];
    for (const { cls, ancestors } of this.classes) {
      if (!ancestors.has(container)) continue;
      const own = cls.getMembers().find((m) => memberName(m) === name && !isStatic(m));
      const unit = own && implementationUnit(own);
      if (unit) out.push(unit);
    }
    for (const literal of this.literals.get(container) ?? []) {
      const prop = literal.getProperty(name);
      const unit = prop && implementationUnit(prop);
      if (unit) out.push(unit);
    }
    return out;
  }
}

function memberName(node: Node): string | undefined {
  if (
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node) ||
    Node.isPropertyAssignment(node) ||
    Node.isShorthandPropertyAssignment(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return node.getName();
  }
  return undefined;
}

function isStatic(node: Node): boolean {
  return "isStatic" in node && (node as { isStatic(): boolean }).isStatic();
}

/** The unit an implementing member runs: its own body, or the function it names (`notify = send`, `{ send }`). */
function implementationUnit(member: Node): Node | undefined {
  const own = unitNodeForDeclaration(member);
  if (own) return own;
  if (Node.isShorthandPropertyAssignment(member)) {
    const value = member.getValueSymbol();
    return value ? unitNodeForSymbol(resolveAlias(value)) : undefined;
  }
  if (Node.isPropertyAssignment(member) || Node.isPropertyDeclaration(member)) {
    const init = member.getInitializer();
    const symbol = init?.getSymbol();
    return symbol ? unitNodeForSymbol(resolveAlias(symbol)) : undefined;
  }
  return undefined;
}

/** Every class and interface a class extends or implements, transitively. */
function classAncestors(cls: ClassNode): Set<Node> {
  const out = new Set<Node>();
  const visit = (node: Node) => {
    if (out.has(node)) return;
    out.add(node);
    for (const next of directBases(node)) visit(next);
  };
  for (const base of directBases(cls)) visit(base);
  return out;
}

function typeAncestors(type: Node): Node[] {
  const out = new Set<Node>();
  const visit = (node: Node) => {
    for (const next of directBases(node)) {
      if (out.has(next)) continue;
      out.add(next);
      visit(next);
    }
  };
  visit(type);
  return [...out];
}

function directBases(node: Node): Node[] {
  const heritage = Node.isClassDeclaration(node) || Node.isClassExpression(node)
    ? [node.getExtends(), ...node.getImplements()]
    : Node.isInterfaceDeclaration(node)
      ? node.getExtends()
      : [];
  return heritage.flatMap((h) => {
    const symbol = h?.getExpression().getSymbol();
    return symbol ? resolveAlias(symbol).getDeclarations() : [];
  });
}

/** The interface, class, or type literal an object literal is written against. */
function contextualTypeDeclarations(literal: ObjectLiteralExpression): Node[] {
  const type = literal.getContextualType();
  if (!type) return [];
  const symbols = [type.getSymbol(), type.getAliasSymbol()].filter((s) => s !== undefined);
  return symbols.flatMap((s) => s.getDeclarations()).filter((d) => !d.getSourceFile().isDeclarationFile());
}
