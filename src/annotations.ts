// Reads `@perm` tags from JSDoc comments.
//
// The raw comment text is scanned instead of relying on the TypeScript JSDoc
// parser, so tags like `@perm-unsafe` or `@permissions` are never mistaken for
// `@perm`, and every entry keeps an exact source position.

import type { JSDoc } from "ts-morph";
import { parsePermList, type Capability } from "./capability.js";

export interface AnnotationError {
  text: string;
  reason: string;
  line: number;
  column: number;
}

export interface PermAnnotation {
  capabilities: Capability[];
  errors: AnnotationError[];
}

const PERM_TAG = /@perm(?![\w-])/g;
const NEXT_TAG = /\s@[A-Za-z]/;
// A line break plus the comment's leading `*`, replaced by spaces so offsets stay exact.
const CONTINUATION = /\n[ \t]*\*(?!\/)/g;

/** Merges every `@perm` tag across the given comments; undefined when there are none. */
export function readPermAnnotation(docs: readonly JSDoc[]): PermAnnotation | undefined {
  let found = false;
  const capabilities: Capability[] = [];
  const errors: AnnotationError[] = [];

  for (const doc of docs) {
    const text = doc.getText();
    const docStart = doc.getStart();
    const sourceFile = doc.getSourceFile();

    for (const tag of text.matchAll(PERM_TAG)) {
      found = true;
      const bodyStart = tag.index + tag[0].length;
      const body = tagBody(text.slice(bodyStart));
      const parsed = parsePermList(body);
      capabilities.push(...parsed.capabilities);

      for (const e of parsed.errors) {
        // An empty tag is reported at the tag itself.
        const pos = e.text === "@perm" ? docStart + tag.index : docStart + bodyStart + e.offset;
        const { line, column } = sourceFile.getLineAndColumnAtPos(pos);
        errors.push({ text: e.text, reason: e.reason, line, column });
      }
    }
  }

  return found ? { capabilities, errors } : undefined;
}

/** The text of one tag: up to the next tag or the end of the comment. */
function tagBody(rest: string): string {
  const close = rest.lastIndexOf("*/");
  let end = close === -1 ? rest.length : close;
  const next = NEXT_TAG.exec(rest);
  if (next && next.index < end) end = next.index;
  return rest.slice(0, end).replace(CONTINUATION, (m) => " ".repeat(m.length));
}
