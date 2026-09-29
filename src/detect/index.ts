// Finds every place in a file that directly uses a capability.
//
// Detection is by resolved declaration, not by name: a local function called
// `fetch` is not the network, and `const post = axios.post; post(url)` is still
// axios. Code whose effects can't be determined is reported as unverifiable.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { classifyComputedCall, computedCallee } from "./computed.js";
import { envUses } from "./env.js";
import { fetchCapability, isUnresolvedFetch } from "./fetch.js";
import { declarationCapabilities, isTimer } from "./functions.js";
import { argumentsOf, callText, literalString, resolvedDeclaration, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";
import { valueUses } from "./values.js";

export type { CapabilityUse } from "./shared.js";

export interface DetectedUse {
  /** Where the use is; its enclosing unit is charged with it. */
  node: Node;
  uses: CapabilityUse[];
}

export function detectInFile(sourceFile: SourceFile, adapters: AdapterIndex): DetectedUse[] {
  const found: DetectedUse[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const capabilities = callCapabilities(node, adapters);
    if (capabilities.length === 0) return;
    const call = callText(node);
    found.push({ node, uses: capabilities.map((capability) => ({ capability, call, verb: "calls" })) });
  });
  found.push(...envUses(sourceFile), ...valueUses(sourceFile, adapters));
  return found;
}

const unverifiable: Capability[] = [{ name: UNVERIFIABLE }];

function callCapabilities(call: CallLike, adapters: AdapterIndex): Capability[] {
  // import(specifier): a literal one is a call-graph edge to that module; any other is unknowable.
  if (Node.isCallExpression(call) && call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
    return literalString(call.getArguments()[0]) === undefined ? unverifiable : [];
  }

  const computed = computedCallee(call);
  if (computed) {
    const target = classifyComputedCall(computed, adapters);
    if (target.kind === "sensitive" || target.kind === "unknown") return unverifiable;
    // "members" become call-graph edges; "resolved" falls through to a normal call.
  }

  const declaration = resolvedDeclaration(call);
  if (declaration) {
    if (isTimer(declaration) && evaluatesString(argumentsOf(call)[0])) return unverifiable;
    return declarationCapabilities(declaration, argumentsOf(call), adapters);
  }
  if (Node.isCallExpression(call) && isUnresolvedFetch(call)) return [fetchCapability(call.getArguments())];
  return [];
}

/** setTimeout("code") evaluates its string, even when a cast hides it from the type checker. */
function evaluatesString(arg: Node | undefined): boolean {
  if (!arg) return false;
  const inner = unwrapExpression(arg);
  return (
    Node.isStringLiteral(inner) ||
    Node.isNoSubstitutionTemplateLiteral(inner) ||
    Node.isTemplateExpression(inner) ||
    inner.getType().isString() ||
    inner.getType().isStringLiteral() ||
    inner.getType().isTemplateLiteral()
  );
}
