# PermLang

**The permission diff for AI-written TypeScript. No new language, no rewrite.**

PermLang is a build-time checker. Every function declares what it can touch
(network, files, database, secrets, system commands), and the build fails when
the code exceeds those declarations.

```ts
/** @perm net(api.stripe.com), db.write(leads), env(STRIPE_KEY) */
export async function chargeCustomer(lead: Lead) { ... }
```

If a change later adds a call to a host that isn't declared:

```
src/leads.ts:9:9 error PERM001: handleLead calls fetch("https://data-broker.io/enrich", ...)
  but its declared permissions do not include net(data-broker.io).
  -> add net(data-broker.io) to @perm, or remove the call.
```

> **Status: pre-release (v0.1, milestone M2).** Not ready for production use.

## What works so far

- **Annotations (M1).** `@perm` tags in JSDoc on functions, methods, constructors,
  accessors, and function-valued `const`s and properties.
- **Direct calls (M1).** The global `fetch` and Node's `fs` / `fs/promises`
  (including `node:` imports, renamed imports, and `fs.promises.*`).
- **Propagation (M2).** A function's actual permissions include everything its
  callees use, across files, through re-exports, recursion, class methods,
  constructors, object methods, and functions passed as callbacks. Violations
  show the path:

  ```
  a calls b("{}"), reaching b → c → writeFileSync("./public/dump.json", ...)
    but its declared permissions do not include fs.write(./public/dump.json).
  ```

- **Module-level permissions (M2).** A top-of-file JSDoc tagged `@module` (or
  `@file` / `@fileoverview`) applies its `@perm` to every function in the file:

  ```ts
  /**
   * Stripe integration.
   * @module
   * @perm net(api.stripe.com)
   */
  ```

- **Warnings.** An exported function with no `@perm` gets a warning (not an
  error) for each capability it reaches. Private helpers need no annotation;
  their callers must cover what they use.

Not yet: `db`/`env`/`exec` detection, adapter manifests, `@perm-unsafe` (M3),
unverifiable-code detection (M4), strictness levels, and `permlang diff` (M5).
See the design doc for the full plan.

### Known gaps (for the M4 adversarial suite)

These currently pass silently. Each will become either a detection or an
"unverifiable" error:

- `fetch` or an fs function used as a value: `urls.map(fetch)`, `const f = fetch`.
- Computed member calls: `obj["send"]()`, `api[name]()`.
- Dynamic dispatch: calls through an interface, or to a method a subclass overrides.
- A subclass constructor reaching its base constructor through `super()`.
- Shorthand properties passing a function: `{ helper }`.
- Top-level code in an imported module (it runs on import).
- Third-party packages: calls into `node_modules` are not followed (adapters in M3).

## Capabilities

| Capability | Meaning | Matching |
| --- | --- | --- |
| `net(host)` | outbound network | exact host, case-insensitive |
| `fs.read(path)` / `fs.write(path)` | file system | the path or anything beneath it |
| `db.read(table)` / `db.write(table)` | database | exact table |
| `env(NAME)` | environment variables and secrets | exact name |
| `exec` | spawning processes | none |

Wildcards (`*`) are not allowed. A capability without an argument (`net`,
`fs.read`) allows any scope. It is required when the host or path can't be
determined statically, for example `fetch(url)` or a template path like
`` `./data/${name}` ``. *(Provisional: this answers open question 1 in the design
doc and is subject to expert review.)*

## Usage

```bash
npm install
npm test                                  # conformance + unit tests
npm run permlang -- check fixtures/m1     # run the checker from source
npm run permlang -- check src --json      # JSON report of declared vs. actual permissions
```

Exit codes: `0` no errors, `1` permission errors, `2` usage error.

## Development

Tests come first. Each rule in the design doc gets passing and failing fixtures
under `fixtures/`. A fixture marks each line that must produce a diagnostic:

```ts
writeFileSync("./data/out.json", data); // expect: error PERM001 fs.write(./data/out.json)
```

Files in `pass/` must produce no diagnostics. Files in `fail/` must produce
exactly the expected ones. A fixture can be a folder of files that import each
other. Every fixture file must be a module (have an import or export).

```
src/capability.ts   vocabulary, parsing, and coverage rules
src/annotations.ts  reading @perm tags from JSDoc and @module comments
src/detect.ts       mapping a call to the capabilities it uses directly
src/units.ts        functions, methods, and files that permissions attach to
src/graph.ts        the call graph and propagation along it
src/check.ts        comparing declared vs. actual per unit
src/report.ts       text and JSON output
src/cli.ts          the permlang command
```

## Prior art

PermLang is a TypeScript implementation of proven ideas. It builds on:

- **Capslock** (Google) and **capcheck** for Go: transitive capability analysis, lock files, and CI gating.
- **efflux** and **libgaze** for Python: declared effects, call-graph checking, and a focus on AI-assisted code.
- **Cackle** for Rust: per-dependency permissions for net, fs, and process.
- **LavaMoat**, **Socket**, and **reachscan** in the JavaScript ecosystem.
- **Bock**, whose strictness levels PermLang's `sketch` / `development` / `production` modes follow.
- Effect systems in **Koka**, **Unison**, **Flix**, **E**, **Pony**, and **Austral**, and the lessons of
  .NET Code Access Security and the Java SecurityManager, which PermLang must stay simpler than.
