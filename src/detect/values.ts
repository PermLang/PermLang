// Capability functions used as values: `urls.map(fetch)`, `promisify(exec)`,
// `paths.forEach(unlinkSync)`. The function can then be called anywhere with any
// arguments, so the reference itself is the use, with every scope dynamic.
//
// Not counted: calling it (that's a call), `typeof fetch`, imports and exports,
// type positions, and `const f = fetch` (calls through a const alias resolve to
// the original by signature, so they're checked where they happen).

import { Node, SyntaxKind, type Identifier, type SourceFile } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { declarationCapabilities } from "./functions.js";
import { resolveAlias, type CapabilityUse } from "./shared.js";

export interface ValueUse {
  node: Node;
  uses: CapabilityUse[];
}

export function valueUses(sourceFile: SourceFile, adapters: AdapterIndex): ValueUse[] {
  const out: ValueUse[] = [];
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const site = referenceExpression(id);
    if (!site || isExempt(site)) continue;
    if (site.getType().getCallSignatures().length === 0) continue;

    const symbol = id.getSymbol();
    if (!symbol) continue;
    for (const declaration of resolveAlias(symbol).getDeclarations()) {
      const capabilities = declarationCapabilities(declaration, [], adapters);
      if (capabilities.length === 0) continue;
      const call = `${site.getText().replace(/\s+/g, " ")} as a value`;
      out.push({ node: site, uses: capabilities.map((capability) => ({ capability, call, verb: "uses" })) });
      break;
    }
  }
  return out;
}

/** The expression an identifier is a value reference through (`fetch`, or `axios.get` for its `get`), if any. */
function referenceExpression(id: Identifier): Node | undefined {
  const parent = id.getParent();
  if (!parent) return undefined;
  if (Node.isPropertyAccessExpression(parent)) {
    // `a.b`: the reference is through `b` (the whole access); `a` alone is just an object.
    return parent.getNameNode() === id ? parent : undefined;
  }
  // Declaration names, parameter names, property names, labels.
  if ("getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === id) return undefined;
  return id;
}

function isExempt(site: Node): boolean {
  const parent = site.getParent();
  if (!parent) return true;
  // Called: the call detector handles it, with its arguments.
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === site) return true;
  if (Node.isTaggedTemplateExpression(parent) && parent.getTag() === site) return true;
  // `fetch.call(...)` and `fetch.bind(...)` are uses: `fetch` is the object of an access, handled here.
  // `a.b.c`: only the outermost access that is a value counts, not `a.b` as an object.
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === site) {
    return !/^(call|apply|bind)$/.test(parent.getName());
  }
  if (Node.isTypeOfExpression(parent)) return true;
  // A const alias: calls through it resolve by signature.
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === site && Node.isIdentifier(parent.getNameNode())) {
    return parent.getVariableStatement()?.getDeclarationKind() === "const";
  }
  for (const a of site.getAncestors()) {
    if (Node.isTypeNode(a) || Node.isImportDeclaration(a) || Node.isExportDeclaration(a) || Node.isExportAssignment(a)) {
      return true;
    }
    if (Node.isStatement(a)) break;
  }
  return false;
}
