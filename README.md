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

> **Status: pre-release (v0.1, milestone M4).** Not ready for production use.

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
- **All v0.1 capabilities (M3).**
  - `env`: any expression typed `NodeJS.ProcessEnv`, so `process.env.KEY`,
    `process.env["KEY"]`, destructuring, `"KEY" in process.env`, and aliases
    (`const env = process.env; env.KEY`). Spreading or enumerating the
    environment needs bare `env`.
  - `exec`: `child_process` (`exec`, `execFile`, `spawn`, `fork`, and their
    `Sync` forms).
  - `net`: also `http`, `https`, `http2`, `net`, and `tls` (host from a URL or
    from an options object's `hostname` / `host`).
  - `db`: **Prisma** (open question 2, provisionally answered). The table is the
    model's accessor name: `prisma.lead.create()` needs `db.write(lead)`. Raw
    SQL (`$queryRaw`, `$executeRaw`, ...) needs bare `db.read` and `db.write`.
- **Adapter manifests (M3).** JSON files mapping a library's functions to
  capabilities, including app-level ones such as `payments.refund`. Built-in
  adapters in [`adapters/`](adapters) cover axios, Stripe, nodemailer, and the Node
  modules above. They were checked against the real axios, stripe@22, and
  @types/nodemailer typings. Library calls resolve by signature, so aliasing a
  method (`const post = axios.post`) doesn't hide it.
- **Escape hatch (M3).** `@perm-unsafe reason:"..."` suppresses one function's
  own checks. Every use is listed in the report. Callers still have to cover
  what the function reaches.

- **Adversarial coverage (M4).** Tricks that try to hide access are caught:
  - capability functions used as values: `urls.map(fetch)`, `promisify(exec)`,
    `paths.forEach(unlinkSync)`, `send.call(...)` (a `const` alias is fine,
    because calls through it resolve to the original);
  - calls through an interface or base class, which reach every first-party
    implementation, including object literals written against the type;
  - `super()`, implicit constructors, and instance field initializers;
  - `{ helper }` shorthand, getters, and literal computed keys (`api["ping"]()`);
  - computed keys over a known object (`handlers[kind]()`), which reach every
    member the key allows;
  - importing a module, which runs its top-level code (static and literal
    `import()`).
- **Unverifiable code (M4, PERM004).** Code whose effects can't be determined is
  an error in annotated functions: `eval`, `new Function`, `setTimeout("code")`,
  `require()`, `import(variable)`, `vm`, `new Worker`, and computed calls on
  sensitive objects (`fs[method]()`, `globalThis[name]()`) or behind an index
  signature (`table[name]()`). The only way to accept it is `@perm-unsafe`,
  which also stops it from failing the function's callers.

Not yet: strictness levels, and `permlang diff` (M5). See the design doc for the
full plan.

### Known limits

Design doc §12 asks the checker to catch the whole adversarial suite, or to
document each miss. These misses are documented as fixtures in
[`fixtures/m4/limits/`](fixtures/m4/limits). Each one's test fails once the miss
is fixed, so the list can't go stale.

- Values typed `any`: nothing called on them can be resolved.
- `Proxy` traps, which can return a capability function for any property.
- Functions attached after the fact (`obj.m = fn`, reassigning a `let`) aren't
  linked to calls through that property or variable. The top-level code that
  assigns them is still reported.

Other gaps, not yet in fixtures:

- Third-party packages without an adapter: calls into them report nothing.
- Database clients other than Prisma (Drizzle, `pg`, ...).
- A `ProcessEnv` received as a parameter typed as a plain object.

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

## Adapter manifests

A manifest maps a package's functions to capabilities. Keys are
`Container.member`, where the container is the class, interface, or type alias
that declares the function. Use `Container()` for a call signature and a bare
`name` for a top-level function. `{host:N}` and `{arg:N}` fill a scope from
argument N:

```json
{
  "permlang": 1,
  "package": "stripe",
  "defines": ["payments.charge", "payments.refund"],
  "default": ["net(api.stripe.com)"],
  "functions": {
    "RefundResource.create": ["payments.refund", "net(api.stripe.com)"],
    "WebhookObject.constructEvent": []
  }
}
```

`default` applies to every other method in the package (not constructors). An
empty list maps a function to nothing. Add your own adapters in
`permlang.config.json`; they take precedence over the built-in ones:

```json
{ "adapters": ["./permlang/adapters/acme-sms.json"] }
```

## Usage

```bash
npm install
npm test                                  # conformance + unit tests
npm run permlang -- check fixtures/m1     # run the checker from source
npm run permlang -- check src --json      # JSON report of declared vs. actual permissions
```

Exit codes: `0` no errors, `1` permission errors, `2` usage or configuration error.

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
src/adapters.ts     adapter manifests: loading, validation, matching
src/detect/         direct uses: fetch, fs, env, Prisma, adapter-mapped calls, values, unverifiable code
src/dispatch.ts     implementations reachable through interfaces and base classes
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
