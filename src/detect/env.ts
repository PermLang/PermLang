// Environment variables: any expression typed NodeJS.ProcessEnv.
//
// Matching the type rather than the text `process.env` means aliases
// (`const env = process.env; env.KEY`) and `import { env } from "node:process"`
// are covered. Any use that can't be tied to one name needs bare `env`.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString, type CapabilityUse } from "./shared.js";

export interface EnvUse {
  node: Node;
  uses: CapabilityUse[];
}

export function envUses(sourceFile: SourceFile): EnvUse[] {
  const out: EnvUse[] = [];
  sourceFile.forEachDescendant((n) => {
    if (!Node.isIdentifier(n) && !Node.isPropertyAccessExpression(n)) return;
    if (isNameNode(n) || !isProcessEnv(n) || n.getFirstAncestor((a) => Node.isTypeNode(a))) return;
    const found = classify(n);
    if (found) out.push(found);
  });
  return out;
}

const named = (name: string): Capability => ({ name: "env", arg: name });
const dynamic: Capability = { name: "env", dynamic: true };

function classify(env: Node): EnvUse | undefined {
  const parent = env.getParentOrThrow();
  const use = (node: Node, capabilities: Capability[]): EnvUse => ({
    node,
    uses: capabilities.map((capability) => ({ capability, call: shorten(node.getText()), verb: "reads" })),
  });

  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === env) {
    return use(parent, [named(parent.getName())]);
  }
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === env) {
    const key = literalString(parent.getArgumentExpression());
    return use(parent, [key === undefined ? dynamic : named(key)]);
  }
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === env) {
    const binding = parent.getNameNode();
    // `const env = process.env` is an alias; its uses are found through their type.
    if (Node.isIdentifier(binding)) return undefined;
    if (Node.isObjectBindingPattern(binding)) {
      const caps = binding.getElements().map((el) => {
        if (el.getDotDotDotToken()) return dynamic;
        const prop = el.getPropertyNameNode();
        if (prop && Node.isComputedPropertyName(prop)) return dynamic;
        return named(prop?.getText() ?? el.getName());
      });
      return use(parent, caps);
    }
  }
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
    const key = literalString(parent.getLeft());
    if (parent.getRight() === env && key !== undefined) return use(parent, [named(key)]);
  }
  // Passed along, spread, enumerated: every variable is reachable.
  return use(parent, [dynamic]);
}

function isProcessEnv(node: Node): boolean {
  const type = node.getType();
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  return (
    symbol?.getName() === "ProcessEnv" && symbol.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile())
  );
}

/** The `env` in `process.env`, or a name being declared: not an expression of its own. */
function isNameNode(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === node;
  return "getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === node;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 70 ? `${oneLine.slice(0, 67)}...` : oneLine;
}
