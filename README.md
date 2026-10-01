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

> **Status: pre-release (v0.1, milestone M5).** Not ready for production use.
> New here? Start with [docs/getting-started.md](docs/getting-started.md).

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
  - `db`: **Drizzle**. The table is the name given to `pgTable` / `mysqlTable` /
    `sqliteTable`: `db.insert(auditLog)`, with `const auditLog = pgTable("audit_log", ...)`,
    needs `db.write(audit_log)`. `pgSchema("s").table("t")` is `s.t`, and `alias(t)`
    is `t`. A name PermLang can't read (computed, from `pgTableCreator`, or held in a
    `let`) could be any table. `.from()` and joins read. `db.query.<key>.findMany()`
    reads `<key>` and each `with` relation, nested ones included; options that
    aren't written out could load any. `db.execute()` is raw SQL, and `migrate()`
    can touch any table.
  - `db`: **raw SQL clients** (`pg`, `mysql2`, `better-sqlite3`, `sqlite3`,
    `postgres`, `@neondatabase/serverless`, `@vercel/postgres`). When the query
    is literal text, its tables are read out of it: `SELECT ... FROM leads JOIN
    teams` needs `db.read(leads), db.read(teams)`. Tagged templates (`` sql`...` ``)
    count, because their substitutions are bound parameters, unless a substitution
    is itself SQL (a postgres.js fragment or `sql(name)` helper). The reader fails
    closed: it names tables only for a single `SELECT`, `INSERT`, `UPDATE`, or
    `DELETE` it fully understands. Anything else (`WITH`, `UNION`, DDL, `COPY`,
    `PRAGMA`, dialect-specific quoting or comments, more than one statement) can
    touch any table, as can SQL built with string concatenation or a template passed
    to `query()`; these need bare `db.read` and `db.write`. So does any client
    method PermLang doesn't know, so new APIs can't pass silently. Schema-qualified
    names are declared as written (`db.read(public.users)`).
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

- **Strictness levels, lock file, permission diff, GitHub Action (M5).** See below.

Not yet: the external review and open-source release (M6). See the design doc for the full plan.

### Known limits

Design doc §12 asks the checker to catch the whole adversarial suite, or to
document each miss. These misses are documented as fixtures in
[`fixtures/m4/limits/`](fixtures/m4/limits) and [`fixtures/m6/limits/`](fixtures/m6/limits).
Each one's test fails once the miss is fixed, so the list can't go stale.

- Values typed `any`: nothing called on them can be resolved. Imports whose
  types can't be found, including packages shimmed with `declare module "x";`,
  are reported (PERM007), whether reached by `import`, `import x = require()`,
  or a literal `import()`.
- `Proxy` traps, which can return a capability function for any property.
- Functions attached after the fact (`obj.m = fn`, reassigning a `let`) aren't
  linked to calls through that property or variable. The top-level code that
  assigns them is still reported.
- Implicit calls made inside a library function: `Promise.resolve(x)` calling
  `then`, `Array.from(x)` running an iterator, `String(x)` calling `toString`.
  Written directly (`await x`, `for...of`, `${x}`, `"" + x`), they're caught.

Other gaps, not yet in fixtures:

- Third-party packages without an adapter: what they touch is trusted. They are
  listed in every report and warned about (PERM006; see below).
- A `ProcessEnv` received as a parameter typed as a plain object.
- A decorator's arguments run when the class is defined, but are charged to the
  decorated member.
- Lock keys for same-named functions in one file (`#2`, `#3`) follow source
  order, so adding one can renumber the others and show spurious lock changes.

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

### Packages without an adapter

PermLang can't see what a package does unless an adapter describes it, so a
package with no adapter is trusted. It's never trusted silently: every report
lists these packages with their call counts, and each one gets a warning
(PERM006) at its first call. Set `"unmapped"` in `permlang.config.json`, or pass
`--unmapped`, to change that:

| Policy | Effect |
| --- | --- |
| `warn` (default) | One warning per package. |
| `error` | One error per package: every package must be mapped or declared pure. |
| `trust` | No diagnostic. The report still lists them. |

A package that touches nothing PermLang tracks is declared pure with an adapter
whose `default` is `[]`. [`adapters/pure.json`](adapters/pure.json) does this for
Node's pure built-ins and common libraries (zod, date-fns, React, ...).

Built-in adapters cover axios, Stripe, nodemailer, `node-fetch`, `undici`, Redis
(`redis`, `ioredis`), Kafka, Bull/BullMQ, ClickHouse, AI SDKs (`ai`, `openai`,
`@anthropic-ai/sdk`, ...), MCP clients, several web APIs, `@nestjs/config`,
`maxmind`, `tar`, and the Node modules that carry capabilities. Where an
adapter can't know a service's hosts, it uses bare `net`. PermLang runs itself
with `"unmapped": "error"` and a team adapter for ts-morph (see
[`permlang.config.json`](permlang.config.json)).

## Strictness levels

Set `"strictness"` in `permlang.config.json`, or pass `--strictness`:

| Level | What fails |
| --- | --- |
| `sketch` | Nothing. Every function's permissions are inferred and reported. Start here on an existing codebase. |
| `development` (default) | Annotated functions that exceed their `@perm`, invalid annotations, unverifiable code, and exported functions or top-level code without `@perm`. |
| `production` | All of the above, plus any function (private helpers too) that reaches something without being covered by function- or module-level `@perm`. |

## The lock file and the permission diff

`permlang lock` writes `permlang.lock.json`: what every function can reach. Commit
it. From then on:

- **`permlang check` fails when the code reaches something the lock doesn't
  record** (PERM005), at every strictness level, sketch included. New access
  can't land without the lock changing, so it always shows up in review.
  Access that was removed is a warning: the lock is stale, but nothing new can
  happen.
- **`permlang diff <base-ref> [paths...]` shows what changed since `base-ref`**, one row per
  new capability, with where it happens and which functions can now reach it:

  | New access | Where it happens | Now reachable from |
  | --- | --- | --- |
  | `+ net(api.data-broker.io)` | `scoreLead`<br>axios.post("https://api.data-broker.io/v2/enrich", ...) | `scoreLead`, `handleLead` |

`--format markdown` produces the pull-request comment; `--format json` is for tools.

The check compares against `./permlang.lock.json` whenever it exists. When
checking other files from the same folder (like the fixtures here), pass
`--no-lock`.

## GitHub Action

```yaml
# .github/workflows/permlang.yml
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  permissions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: PermLang/permlang@main
        with:
          args: src            # or --project tsconfig.json
```

The Action runs `permlang check`, fails the build on errors, and posts the
permission diff as a pull-request comment, updating it on later pushes. The
repository is private for now, so the Action can only be used from repositories
in the PermLang organization. This repository runs it on itself (see
`.github/workflows/permlang.yml` and `permlang.lock.json`).

## Usage

```bash
npm install
npm test                                           # conformance + unit tests
npm run permlang -- init src                        # set up a project: sketch config + first lock
npm run permlang -- check fixtures/m1 --no-lock    # run the checker from source
npm run permlang -- check src --json               # JSON report of declared vs. actual permissions
npm run permlang -- lock src                       # write permlang.lock.json
npm run permlang -- diff origin/main               # permission changes since main
npm run permlang -- spec src                       # check .perm specs against the code
```

Exit codes: `0` no errors, `1` permission errors, `2` usage or configuration error.

## Specs (phase 2 groundwork)

A `.perm` spec describes one piece of logic in one file: rules, examples, and the
permissions its implementation may use.

```
perm process_refund(order: Order, reason: Text) -> RefundResult
  implements: src/refunds.ts#processRefund
  must:
    never refund more than the amount paid
  examples:
    order(paid: $120, 5 days ago) -> refunded($120)
  perms:
    db.read(orders), db.write(refunds), payments.refund
```

`permlang spec src` checks each spec's `perms:` against what the implementation
actually reaches. Rules and examples are parsed and reported as not yet verified.
See [docs/spec-format.md](docs/spec-format.md).

## Real-world trial

[docs/trial-2026-09.md](docs/trial-2026-09.md): PermLang on Umami (1,372 files, 22 s)
and Ghostfolio's API (524 files, 9 s). It found and fixed three false-positive
classes and one false-negative class (Prisma clients built with `$extends`),
found no false positives in a spot check of its network, process, and file-write
findings, and identified the main remaining false negative: SDKs without
adapters. Run `prisma generate` before PermLang in CI, or database access is
invisible.

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
src/lock.ts         permlang.lock.json: build, read, compare
src/diff.ts         the permission diff, as text or a pull-request comment
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

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license covers
the code; it grants no rights to the PermLang name or marks (Section 6).
