// Calls through a computed key, `obj[key](...)`. With a single literal key they
// resolve like any other call. Otherwise:
//   - on a sensitive object (fs, globalThis, an SDK), any capability function
//     could be reached, so the call is unverifiable;
//   - on a first-party object with known members, every member the key allows
//     could be called, so each becomes a call-graph edge;
//   - behind an index signature (arrays, Record<string, Fn>), the functions
//     can't be known, so the call is unverifiable.

import { Node, type ElementAccessExpression, type Symbol as MorphSymbol, type Type } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { declarationCapabilities } from "./functions.js";
import { unwrapExpression, type CallLike } from "./shared.js";

export type ComputedTarget =
  | { kind: "resolved" }
  | { kind: "sensitive" }
  | { kind: "members"; members: MorphSymbol[] }
  | { kind: "unknown" };

/** The element access a call goes through, if its callee is `obj[key]`. */
export function computedCallee(call: CallLike): ElementAccessExpression | undefined {
  if (Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  return Node.isElementAccessExpression(callee) ? callee : undefined;
}

export function classifyComputedCall(access: ElementAccessExpression, adapters: AdapterIndex): ComputedTarget {
  const key = access.getArgumentExpression();
  const keyType = key?.getType();
  if (!key || !keyType) return { kind: "unknown" };
  if (keyType.isStringLiteral() || keyType.isNumberLiteral()) return { kind: "resolved" };

  const object = access.getExpression();
  const objectType = object.getType();
  if (objectType.isAny() || objectType.isUnknown()) return { kind: "unknown" };

  const callable = callableMembers(objectType, access);
  if (callable.some((m) => isSensitive(m, adapters))) return { kind: "sensitive" };

  // A numeric key into an array or tuple of functions: the elements can't be named.
  if (keyType.isNumber() || keyType.isNumberLiteral()) return { kind: "unknown" };
  const index = objectType.getStringIndexType();
  if (index && index.getCallSignatures().length > 0) return { kind: "unknown" };

  // A union of literal keys narrows the members; any other string key allows all of them.
  const allowed = keyType.isUnion() && keyType.getUnionTypes().every((t) => t.isStringLiteral())
    ? new Set(keyType.getUnionTypes().map((t) => String(t.getLiteralValue())))
    : undefined;
  const members = callable.filter((m) => !allowed || allowed.has(m.getName()));
  return members.length > 0 ? { kind: "members", members } : { kind: "unknown" };
}

function callableMembers(type: Type, at: Node): MorphSymbol[] {
  return type.getProperties().filter((p) => p.getTypeAtLocation(at).getCallSignatures().length > 0);
}

function isSensitive(member: MorphSymbol, adapters: AdapterIndex): boolean {
  return member.getDeclarations().some((d) => declarationCapabilities(d, [], adapters).length > 0);
}
