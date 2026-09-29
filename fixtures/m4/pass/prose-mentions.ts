// Found by running PermLang on its own source: prose that mentions a tag is not a tag.
// In JSDoc, a block tag starts a line (after the leading `*`).

/**
 * Parses the body of a `@perm` tag, e.g. `net(api.stripe.com), env(KEY)`.
 * Only @perm-unsafe can accept unverifiable code.
 */
export function describeTags(text: string) {
  return text.length;
}
