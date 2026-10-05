# PermLang reference

The details behind the [README](../README.md): what PermLang detects, how
capabilities match, adapters, the lock file, the GitHub Action, the CLI, and what
it can't see yet. New here? Start with [getting started](getting-started.md).

## What it checks

- **Annotations.** `@perm` tags in JSDoc on functions, methods, constructors,
  accessors, and function-valued `const`s and properties.
- **Direct calls.** The global `fetch` and Node's `fs` / `fs/promises`
  (including `node:` imports, renamed imports, and `fs.promises.*`).
- **Propagation.** A function's actual permissions include everything its
  callees use, across files, through re-exports, recursion, class methods,
  constructors, object methods, and functions passed as callbacks. Violations
  show the path:

  ```
  a calls b("{}"), reaching b → c → writeFileSync("./public/dump.json", ...)
    but its declared permissions do not include fs.write(./public/dump.json).
  ```

- **Module-level permissions.** A top-of-file JSDoc tagged `@module` (or
  `@file` / `@fileoverview`) applies its `@perm` to every function in the file:

  ```ts
  /**
   * Stripe integration.
   * @module
   * @perm net(api.stripe.com)
   */
  ```

- **Missing annotations.** At the default strictness, an exported function
  with no `@perm` is an error (PERM003) for each capability it reaches. Private
  helpers need no annotation; their callers must cover what they use. See
  [Strictness levels](#strictness-levels).
- **All v0.1 capabilities.**
  - `env`: any expression typed `NodeJS.ProcessEnv`, so `process.env.KEY`,
    `process.env["KEY"]`, destructuring, `"KEY" in process.env`, and aliases
    (`const env = process.env; env.KEY`). Spreading or enumerating the
    environment needs bare `env`.
  - `exec`: `child_process` (`exec`, `execFile`, `spawn`, `fork`, and their
    `Sync` forms).
  - `net`: also `http`, `https`, `http2`, `net`, and `tls` (host from a URL or
    from an options object's `hostname` / `host`).
  - `db`: **Prisma**. The table is the
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
- **Adapter manifests.** JSON files mapping a library's functions to
  capabilities, including app-level ones such as `payments.refund`. Built-in
  adapters in [`adapters/`](../adapters) cover HTTP clients, Stripe, email, Redis,
  Kafka, queues, AI SDKs, and more (see [below](#adapter-manifests)). Library
  calls resolve by signature, so aliasing a method (`const post = axios.post`)
  doesn't hide it.
- **Escape hatch.** `@perm-unsafe reason:"..."` suppresses one function's
  own checks. Every use is listed in the report. Callers still have to cover
  what the function reaches.
- **Adversarial coverage.** Tricks that try to hide access are caught:
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
- **Unverifiable code (PERM004).** Code whose effects can't be determined is
  an error in annotated functions: `eval`, `new Function`, `setTimeout("code")`,
  `require()`, `import(variable)`, `vm`, `new Worker`, and computed calls on
  sensitive objects (`fs[method]()`, `globalThis[name]()`) or behind an index
  signature (`table[name]()`). The only way to accept it is `@perm-unsafe`,
  which also stops it from failing the function's callers.
- **Project configuration (PERM005).** GitHub workflows, Actions, and
  `package.json` scripts are recorded in the lock like code: token permissions,
  secrets, Actions and whether they're pinned, install hooks. See
  [project configuration](#project-configuration).
- **Tools given to AI models (PERM008).** Functions registered as AI tools, and
  what a model can trigger through them. See
  [tools given to AI models](#tools-given-to-ai-models).
- **Data-flow rules (PERM009).** Where a secret or sensitive data may be sent.
  See [data-flow rules](#data-flow-rules).
- **New dependencies** in the permission diff, with what PermLang sees of each
  and its install scripts.
- **Strictness levels, a lock file, a permission diff for pull requests, a
  GitHub Action with line annotations and code scanning, and SARIF output.** See
  below.

### Known limits

The aim is to catch the whole adversarial suite, or to document each miss. These misses are documented as fixtures in
[`fixtures/m4/limits/`](../fixtures/m4/limits) and [`fixtures/m6/limits/`](../fixtures/m6/limits),
and as "known misses" in the adversarial suite
([`test/adversarial.test.ts`](../test/adversarial.test.ts)), which also lists
the harmless code that must stay silent. Each miss's test fails once it's fixed,
so the list can't go stale.

- Values typed `any`: nothing called on them can be resolved. Where a value
  with known capabilities becomes `any`, the escape itself is checked:
  - A member read off a cast is looked up on the original type and reported as
    the access it is: `(globalThis as any).fetch(url)`,
    `(childProcess as any)["exec"](cmd)`, `(process as any).env.KEY`. Casts to
    `Record<string, any>` and through `unknown` count too.
  - A capability module that escapes any other way (stored, passed, or returned as
    `any`, or read with a computed key) is unverifiable (PERM004).
  - `const f: any = fetch` counts as using `fetch`, and `declare const require: any`
    and `(require as any)(...)` are still `require`.

  Two things stay unchecked. A global object stored as `any`
  (`const w = window as any; w.fetch(url)`) isn't followed: that cast is common
  and almost always harmless, so it isn't reported. And a value that was `any`
  from the start, such as an untyped parameter, has nothing to trace. Imports
  whose types can't be found, including packages shimmed with
  `declare module "x";`, are reported (PERM007), whether reached by `import`,
  `import x = require()`, or a literal `import()`.
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
- The Action knows whether the lock file existed before only on pull requests
  and merge-queue entries, from their base commit. On a push, a deleted lock
  file isn't detected.
- A pull request that changes the Action's `args` to use a new `--lock` file,
  one the base commit doesn't have, isn't held to the old one: the check uses
  the new file, and the comment lists all access as new and says the base has
  no lock file.
- New dependencies are described with the pull request's own adapters. An
  adapter the pull request adds or changes is itself a settings change, which
  fails the check and is listed in the comment.
- Of tsconfig.json's compiler options, only those that decide which files are
  read and what imports and globals resolve to are recorded (see
  [what the lock records](#what-the-lock-records)).
- If the Action can't look up the account its token belongs to, it assumes
  `github-actions[bot]`; with another kind of token, it then adds a new comment
  on each push instead of updating one.

## Configuration

`permlang.config.json`, next to the lock file. Every setting is optional.

```json
{
  "strictness": "development",
  "unmapped": "warn",
  "tools": "warn",
  "adapters": ["./permlang/adapters/acme-sms.json"],
  "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }]
}
```

| Setting | Values | Meaning |
| --- | --- | --- |
| `strictness` | `sketch`, `development` (default), `production` | What fails the build. See [strictness levels](#strictness-levels). The `--strictness` option overrides it. |
| `unmapped` | `warn` (default), `error`, `trust` | Calls into packages with no adapter, and imports with no types. See [packages without an adapter](#packages-without-an-adapter). The `--unmapped` option overrides it. |
| `tools` | `warn` (default), `error`, `trust` | AI tools that reach something dangerous. See [tools given to AI models](#tools-given-to-ai-models). |
| `adapters` | paths | Your own adapter manifests, relative to the config file. See [adapter manifests](#adapter-manifests). |
| `flows` | rules | Where protected data may go. See [data-flow rules](#data-flow-rules). |

Any other key is an error (exit code 2) that names it, since a typo such as
`"strictnes"` would otherwise leave the default in place unseen. `"$schema"` is
allowed.

The settings in effect, after command-line options, are recorded in the lock
file along with the paths checked, so changing them fails the check until
`permlang lock` records the change. See [what the lock records](#what-the-lock-records).

## Diagnostic codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `PERM001` | error | A function reaches a capability its `@perm` doesn't declare. |
| `PERM002` | error | An `@perm` annotation is invalid. |
| `PERM003` | error | A function that must declare its permissions has no `@perm`: exported functions at development, every function at production. See [strictness levels](#strictness-levels). |
| `PERM004` | error | Code whose effects can't be determined statically, such as `eval` or a capability hidden behind `any`. |
| `PERM005` | error | The code and `permlang.lock.json` differ: the code reaches something the lock doesn't record, or the lock records something the code no longer reaches; a `@perm-unsafe` override is new, gone, or has another reason; the check ran on other files or with other settings than the lock records; the lock is missing (with `--require-lock`); or an older PermLang wrote it. See [the lock file](#the-lock-file-and-the-permission-diff). |
| `PERM006` | warning, by default | A call into a package with no adapter: what it touches isn't checked. See [packages without an adapter](#packages-without-an-adapter). |
| `PERM007` | warning, by default | An import whose types can't be found, so nothing called from it is checked. |
| `PERM008` | warning, by default | A tool an AI model can call reaches something dangerous. See [tools given to AI models](#tools-given-to-ai-models). |
| `PERM009` | error | A function reads data a flow rule protects and can send it somewhere the rule doesn't allow. See [data-flow rules](#data-flow-rules). |
| `SPEC001`–`SPEC004` | error or warning | Problems with `.perm` specs: see [specs](#specs-phase-2-groundwork). |

Sketch strictness reports everything but fails only on `PERM005`.

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
`` `./data/${name}` ``.

## Data-flow rules

`@perm` says what a function may touch. A flow rule says where protected data
may *go*: "the Stripe key may only be sent to Stripe".

```json
{
  "flows": [
    { "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] },
    { "from": "db.read(customers)", "to": ["net(api.hubspot.com)"] }
  ]
}
```

A function that reads the `from` capability directly, and can send to a host
`to` doesn't list, is a `PERM009` error. That covers sending itself or through
anything it calls, and a host that can't be determined (`fetch(url)`). The
error points at the call that leads there:

```
src/billing.ts:7:9 error PERM009: charge reads env(STRIPE_KEY) and can send to net(analytics.example),
  through track → fetch("https://analytics.example/event", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.
```

A `from` without a scope covers a whole category: `"env"` protects every
environment variable. Reading the whole environment (`JSON.stringify(process.env)`)
counts as reading every variable.

**This first version works per function.** It doesn't follow the value itself:
a key read into a module-level constant and used by another function isn't
caught, and neither is one passed to a callee as an argument. Callers of a
function that reads the key aren't flagged, since the key stays inside it. Only
network hosts are checked as destinations.

## Tools given to AI models

A function registered as a tool for an AI model runs when the model decides to
call it, and the model does what its input tells it to. So whoever controls that
input (a user, a web page the model reads, an email it summarizes) can trigger
the tool. If the tool can run commands, that's prompt injection turned into
code execution.

PermLang finds tool registrations and works out what each tool's handler can
reach, through everything it calls:

| Framework | Recognized |
| --- | --- |
| Vercel AI SDK (`ai`) | `tool({ execute })`, `dynamicTool(...)` |
| MCP (`@modelcontextprotocol/sdk`) | `server.tool(name, ..., handler)`, `server.registerTool(name, config, handler)`, and `setRequestHandler(CallToolRequestSchema, handler)`, which serves every tool (named `*`) |
| OpenAI Agents (`@openai/agents`) | `tool({ name, execute })` |
| LangChain (`@langchain/core`, `langchain`) | `tool(func, ...)`, `new DynamicStructuredTool({ func })`, and other `new ...Tool(...)` classes |
| Anthropic, Mastra, LlamaIndex | their `tool`/`createTool`/`betaTool`-style helpers with an `execute`, `run`, or `func` handler |

Every tool is listed in the report, with what it reaches. When a tool reaches
something a model shouldn't trigger unchecked, there's a `PERM008` warning at
the registration:

- running commands (`exec`) or code that can't be verified;
- writing files or data (`fs.write`, `db.write`);
- sending to a host that isn't fixed (bare `net`), since the model can choose
  where data goes;
- app-level actions from adapters, such as `payments.refund` or `email.send`.

Reading files, tables, environment variables, or a fixed host doesn't warn: that's
what tools are for. Set `"tools"` in `permlang.config.json` to `"error"` to fail
the build instead, or `"trust"` to only list them.

In the pull-request comment, new access a tool can reach is marked *An AI model
can trigger this*, with the tool's name.

A handler PermLang can't find (passed in from elsewhere, say) counts as
unverifiable. Tools registered through a wrapper of your own aren't recognized
yet.

## Project configuration

Workflows and scripts grant as much as code does, and AI agents edit them as
readily. So the lock also records, for the folder it lives in:

- **GitHub workflows** (`.github/workflows/*.yml`), and **composite Actions**
  (`action.yml`, `.github/actions/**/action.yml`);
- **`package.json` scripts.**

Each file is an entry in the lock, keyed by its path (for example
`.github/workflows/ci.yml#<ci.yml>`), and what it grants are its capabilities:

| Capability | Meaning |
| --- | --- |
| `ci.trigger(event)` | An event the workflow runs on, such as `pull_request_target`. |
| `ci.permission(scope: level)` | A token permission a job gets, from its own `permissions:` or the workflow's. `ci.permission(write-all)` and `ci.permission(read-all)` for the shorthands; `ci.permission(default)` when neither sets any, so the token gets the repository's default, which can be write access to everything. |
| `ci.secret(NAME)` | A secret the file reads (`secrets.NAME`). `ci.secret(inherit)` for `secrets: inherit`; `ci.secret(all)` for `toJSON(secrets)`. |
| `ci.action(owner/repo)` | An Action or reusable workflow a step or job runs (`uses:`). |
| `ci.unpinned(owner/repo)` | ...referenced by a tag or branch rather than an exact commit, so what runs can change without a change here. |
| `npm.script(name: command)` | A `package.json` script and its command, lifecycle hooks such as `postinstall` included. |
| `ci.unverifiable`, `npm.unverifiable` | A file PermLang can't parse. It's recorded rather than skipped, so it can't hide anything. |

A change that adds one fails the check (`PERM005`) at the line that grants it,
and shows in the pull-request comment, until `permlang lock` records it. So does
a change that removes one, or a lock that records one the files don't grant.
That's the same review gate as for code. Updating a pinned Action to a new commit
doesn't change the lock, but switching it to a tag does. Steps' `run:` commands
aren't recorded yet.

**Upgrading from 0.3 or earlier:** there's no grace period. A lock written
before 0.4 fails the check with one error until `permlang lock` rewrites it; see
[upgrading the lock](#upgrading-from-03-or-earlier).

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
whose `default` is `[]`. [`adapters/pure.json`](../adapters/pure.json) does this for
Node's pure built-ins and common libraries (zod, date-fns, React, ...).

Built-in adapters cover axios, Stripe, nodemailer, `node-fetch`, `undici`, Redis
(`redis`, `ioredis`), Kafka, Bull/BullMQ, ClickHouse, AI SDKs (`ai`, `openai`,
`@anthropic-ai/sdk`, ...), MCP clients, several web APIs, `@nestjs/config`,
`maxmind`, `tar`, and the Node modules that carry capabilities. Where an
adapter can't know a service's hosts, it uses bare `net`. PermLang runs itself
with `"unmapped": "error"` and a team adapter for ts-morph (see
[`permlang.config.json`](../permlang.config.json)).

## Strictness levels

Set `"strictness"` in `permlang.config.json`, or pass `--strictness`:

| Level | What fails |
| --- | --- |
| `sketch` | Nothing. Every function's permissions are inferred and reported. Start here on an existing codebase. |
| `development` (default) | Annotated functions that exceed their `@perm`, invalid annotations, unverifiable code, and exported functions or top-level code without `@perm`. |
| `production` | All of the above, plus any function (private helpers too) that reaches something without being covered by function- or module-level `@perm`. |

## The lock file and the permission diff

`permlang lock` writes `permlang.lock.json`: what every function can reach, what
every workflow, Action, and `package.json` script grants, and which files the check
ran on and with which settings. Commit it. From then on:

- **`permlang check` fails when the code and the lock differ in any way**
  (PERM005), at every strictness level, sketch included:
  - The code reaches something the lock doesn't record. New access can't land
    without the lock changing, so it always shows up in review. The error points
    at the line that reaches the new access, such as the new `fetch` or the call
    into a helper that makes it.
  - The lock records something the code doesn't reach. Otherwise a pull request
    could approve access in advance by editing only the lock, for a later change
    to use without showing up. The error points at the lock's own line.
  - A `@perm-unsafe` override is new, gone, or has a different reason.
  - The check ran on other files, or with other settings, than the lock records
    (see below).

  To approve any of these, run `permlang lock` and commit the change, so
  reviewers see it.
- **`permlang diff <base-ref> [paths...]` shows what changed since `base-ref`**, one row per
  new capability, with where it happens and which functions can now reach it:

  | New access | Where it happens | Now reachable from |
  | --- | --- | --- |
  | `+ net(api.data-broker.io)` | `scoreLead`<br>axios.post("https://api.data-broker.io/v2/enrich", ...) | `scoreLead`, `handleLead` |

  The diff compares `base-ref`'s lock with what the code reaches now, not only
  with the lock file on disk. With `--head <ref>`, it compares two committed lock
  files. Above the table, it says whatever makes it incomplete or the check fail:
  - **Not approved yet**, when the code and the lock file don't match. Access the
    lock records but the code doesn't reach is listed under its own heading.
  - When the change deletes the lock file, or an older PermLang wrote it.
  - When the code couldn't be analyzed (an invalid setting, say). The diff then
    shows only what the lock files record, says so, and never says "No permission
    changes".
  - When the base commit has no lock file, so everything is listed as new.

  Changes to what's checked, or how strictly, are listed under **Check settings
  changed**, such as `unmapped: now trust, was warn`, or an `exclude` added to
  tsconfig.json. New and changed `@perm-unsafe` reasons are listed with the old
  reason.

  The diff also lists **new dependencies**: packages the change adds to
  `./package.json`, in `dependencies`, `devDependencies`, `optionalDependencies`,
  or `peerDependencies`. For each one, it says what PermLang sees (checked by an
  adapter, declared pure, detected directly, or **not checked** because it has no
  adapter) and lists its `preinstall`, `install`, and `postinstall` scripts when
  it's installed. It also lists a package already there that the change now
  installs from somewhere other than the registry: an alias
  (`"lodash": "npm:evil-lodash@1.0.0"`), a URL, git, or a local folder or tarball.
  Its name, and so its adapter, stay the same while its code changes. These are
  there for review: they don't fail the check, although calls into a package with
  no adapter get a `PERM006` warning.

`--format markdown` produces the pull-request comment. Text from the code is
escaped so it can't change the comment: it can't break out of code formatting or
a table, hide rows in an HTML comment, mention people (`@name`), or link issues,
commits, URLs, or emoji (an invisible zero-width space breaks those). The
comment stays under GitHub's length limit: a row names at most 20 functions,
and when the comment would still be too long, it's cut short from the end, the
new-access table first in line to stay, with a note saying how much is left out.
If the diff can't be computed at all (the base commit can't be read, say),
`--format markdown` still prints a comment that says so, and the command exits 2.

`--format json` is for tools, and includes `unrecorded` (where the code and the
lock file differ, or `null`), `unsafeChanged`, `analysisError` (or `null`),
`lockDeleted`, `baseLockMissing`, and `dependencies` (each with its `section`, and
`change`: `added` or `source`).

The text output of `check`, `lock`, and `diff` escapes line breaks and control
characters in anything from the code (`\n`, `\u001b`), so a string in the code
can't print a line of its own, which GitHub Actions would obey as a workflow
command, or drive the terminal.

The check compares against `./permlang.lock.json` whenever it exists. When
checking other files from the same folder (like the fixtures here), pass
`--no-lock`.

### What the lock records

```json
{
  "permlang": 2,
  "functions": {
    ".github/workflows/ci.yml#<ci.yml>": ["ci.permission(contents: read)", "ci.trigger(pull_request)"],
    "permlang.config.json#<permlang.config.json>": [
      "permlang.files(src)",
      "permlang.strictness(development)",
      "permlang.tools(warn)",
      "permlang.unmapped(warn)"
    ],
    "src/leads.ts#handleLead": ["db.write(lead)", "email.send"]
  },
  "unsafe": { "src/render.ts#compile": "template compiler; trusted input" }
}
```

Keys are `<path>#<function>`, with the path relative to the lock file. Several
functions of the same name in one file get `#2`, `#3`, in source order, and
`@perm-unsafe` overrides are keyed the same way. A `#` or `%` in a file's name is
written `%23` or `%25`, so the first `#` always ends the path. Functions that
reach nothing are left out.

The settings are an entry keyed by the config file (`permlang.config.json`, or
the `--config` file), whether or not it exists:

| Capability | What it records |
| --- | --- |
| `permlang.files(path)`, or `permlang.project(tsconfig.json)` | The files checked: the paths given (`src` when none are given and there's no `./tsconfig.json`), or the TypeScript project given with `--project` or found as `./tsconfig.json`. |
| `permlang.strictness(level)`, `permlang.unmapped(policy)`, `permlang.tools(policy)` | The settings in effect: a command-line option (or the Action's `strictness` input), else `permlang.config.json`, else the default. |
| `permlang.flow(from -> to)` | Each [flow rule](#data-flow-rules). |
| `permlang.adapter(path sha256:...)` | Each adapter manifest, from the config file or `--adapter`, with the first 16 hex digits of the SHA-256 of its content. The content is hashed as parsed JSON, so line endings and formatting don't change it. |

When the files come from a TypeScript project, its config is an entry too: its
`include`, `exclude`, and `files` after following `extends` (TypeScript's
defaults when they aren't set: everything included, the output folders
excluded), and the compiler options that decide what imports and globals resolve
to: `baseUrl`, `paths`, `rootDirs`, `typeRoots`, `types`, `lib`, `noLib`,
`allowJs`, `moduleResolution`, `customConditions`, and `moduleSuffixes`.
A tsconfig.json that can't be parsed, or that extends a file that isn't there, is
an error (exit code 2).

So narrowing `include`, lowering `strictness`, trusting packages with no adapter,
adding an adapter that declares a package pure, dropping a flow rule, or checking
other paths all fail the check until `permlang lock` records them, and show in
the pull-request comment.

**Check with the paths and options the lock was written with.** A check of
other files fails with one error that says which files each was for:

```
permlang.config.json:1:1 error PERM005: This check ran on --project tsconfig.json, but permlang.lock.json was written for src.
```

A check with other settings fails with an error for each one:

```
permlang.config.json:1:1 error PERM005: The check runs with unmapped: trust (from --unmapped), but permlang.lock.json records unmapped: warn.
```

To change them, run `permlang lock` with the new paths and options, and commit
the change. To try other settings without the lock, add `--no-lock`.

**A missing lock file.** With `--require-lock`, a missing lock is an error
(PERM005); the GitHub Action passes it when the pull request's base commit has
the lock. A `--lock <file>` that doesn't exist is a usage error (exit code 2), so
a mistyped path can't turn the comparison off. `--no-lock` with `--require-lock`
is a usage error too. Without any of these, a check with no lock file checks
only annotations.

#### Upgrading from 0.3 or earlier

Locks written before 0.4 are format 1, which recorded no settings. `permlang
check` fails on one with a single error:

```
permlang.lock.json:1:1 error PERM005: permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.
  -> run `permlang lock` once to update it, and commit the change.
```

Run `permlang lock` once, with the paths and options your check uses, and commit
the result. Nothing in a pull request can make the check lenient instead: there's
no grace period. `permlang lock` also replaces a lock it can't read at all (one
with merge-conflict markers, say), with a warning to review all of it.

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
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
      - run: npm ci --ignore-scripts   # or pnpm / yarn; see below
      - uses: PermLang/permlang@v0
        with:
          args: src            # or --project tsconfig.json
```

**Install dependencies before the Action.** PermLang reads code through the
TypeScript compiler, so it needs your dependencies' types, `@types/node` above
all. Without them, file, process, and environment access are invisible, and the
check reports `PERM007` warnings instead of what the code does.
`permlang init --workflow` writes this step for npm, pnpm, or yarn, based on
your lockfile. Install scripts aren't needed for types; if you generate code,
such as with `prisma generate`, run that too.

What `init --workflow` writes:

- **pnpm and Yarn** come through Corepack, which the workflow installs from npm
  first (`npm install --global corepack@latest`), since Node 25 and later no
  longer include it. Yarn 2 and later (a `.yarnrc.yml`, or a Yarn 2 lockfile)
  install with `--immutable --mode=skip-build`; Yarn 1 with
  `--frozen-lockfile --ignore-scripts`.
- **Triggers**: pull requests, merge queues (`merge_group`), and pushes to the
  repository's default branch (from `origin`'s HEAD, else `main`).
- **In a monorepo package**, run `init` in the package: the workflow goes in
  the repository's `.github/workflows/`, named after the package
  (`permlang-packages-api.yml`), with `working-directory` set to it.
  Dependencies install at the repository root, where the lockfile is.
- **Paths** are written with forward slashes. A path with a space can't be
  passed in the Action's `args`, so `init` refuses it; list such files in a
  `tsconfig.json` and use `--project`.

`init` keeps an existing config, workflow, or lock. It writes the workflow
before the lock, so the lock records it and the first pull request passes.

The Action runs `permlang check`, fails the build on errors, and posts the
permission diff as a pull-request comment, updating it on later pushes. Each
problem also appears as an annotation on its line in the pull request's
**Files changed** tab, and in the check's summary. GitHub shows up to 10 error
and 10 warning annotations per step; the full list is in the log and the
comment. This repository runs it on itself (see
`.github/workflows/permlang.yml` and `permlang.lock.json`).

`@v0` follows the latest 0.x release. A minor release (0.2, 0.3, ...) can
detect more and fail builds that passed before; the [changelog](../CHANGELOG.md)
says when. To upgrade on your own schedule, pin an exact release instead. The
safest pin is the release's commit, since a tag can be moved
(`PermLang/permlang@<commit-sha> # v0.3.3`); Dependabot keeps such pins up to
date. See the [releases](https://github.com/PermLang/PermLang/releases).

**Code scanning.** Set `sarif: true` to also upload the findings to GitHub code
scanning, where they appear in the repository's **Security** tab next to
CodeQL's, and close on their own once fixed. The workflow needs
`security-events: write` in its `permissions:`. The upload is best effort: on a
pull request from a fork, whose token is read-only, it's skipped and the check
still runs. Each `working-directory` uploads under its own category
(`permlang`, or `permlang/<folder>`), so runs for several folders don't replace
each other's alerts.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write
# ...
      - uses: PermLang/permlang@v0
        with:
          args: src
          sarif: true
```

| Input | Default | Meaning |
| --- | --- | --- |
| `args` | | Arguments for `permlang check`: source paths, or `--project tsconfig.json`. |
| `strictness` | | `sketch`, `development`, or `production`. Overrides `permlang.config.json`. |
| `working-directory` | `.` | Where the code, `permlang.config.json`, and `permlang.lock.json` are. |
| `comment` | `true` | Post the permission diff as a pull-request comment. |
| `sarif` | `false` | Also upload the findings to code scanning. |
| `github-token` | `github.token` | Token for the comment. |

| Output | Meaning |
| --- | --- |
| `exit-code` | The exit code of `permlang check`: `0` no errors, `1` permission errors, `2` anything else (a usage or configuration error, a file that can't be read or written, or an internal error). |

**The inputs and the lock file.** `args` and `strictness` change what's checked,
so the lock file records them, as it does `permlang.config.json`: a pull request
that changes them in its workflow fails the check until `permlang lock` is run
with the same arguments and options, and committed. For a workflow with
`args: src` and `strictness: sketch`, that's `npx permlang lock src --strictness sketch`.

**A deleted lock file.** On pull requests and merge-queue entries, the Action
fetches the base commit first. When the base has the lock file
(`permlang.lock.json`, or the file `--lock` names in `args`), the check runs with
`--require-lock`, so deleting the lock fails it, and the comment says the pull
request deletes it. When the base commit can't be fetched, the lock is required
anyway, with a warning. `--no-lock` in `args` then stops the check with a usage
error.

**The comment.** The Action updates its own comment on each push. It finds the
comment by its first line, a marker that names the `working-directory` when it
isn't the repository root (so runs for several folders each keep their own), and
by the account of the token that posted it: `github-actions[bot]` for the default
token, or a personal token's owner. It never edits a comment from another
account. The comment's text goes to GitHub in a file, and stays under GitHub's
length limit. If its comment can't be updated, the step fails, since the old
comment would go on looking current. If the diff can't be computed, the comment
says so instead. Other problems (fetching the base commit, posting a first
comment without `pull-requests: write`) are warnings, and the diff is always in
the job summary. A pull request from a fork gets the diff in the job summary
only, since its token is read-only.

**Node.** The Action runs PermLang on Node 22, from the runner's tool cache, by
its full path, so the Node your later steps use doesn't change. On a runner
without Node 22 in its tool cache (some self-hosted runners), it installs it
with `actions/setup-node` (with its package-manager cache turned off), which
does put it first on the PATH for later steps.

## Usage

```bash
npm install
npm test                                           # conformance + unit tests
npm run permlang -- init src                        # set up a project: sketch config + first lock
npm run permlang -- check fixtures/m1 --no-lock    # run the checker from source
npm run permlang -- check src --json               # JSON report of declared vs. actual permissions
npm run permlang -- check src --github-annotations # also print GitHub Actions annotations (the Action does this)
npm run permlang -- check src --sarif out.sarif    # also write the findings as SARIF, for code scanning
npm run permlang -- lock src                       # write permlang.lock.json
npm run permlang -- check src --require-lock       # also fail when permlang.lock.json is missing
npm run permlang -- diff origin/main               # permission changes since main
npm run permlang -- spec src --spec x.perm        # check a .perm spec against the code
npm run permlang -- --version                      # the installed version
npm run permlang -- check --help                   # usage (any command)
```

Exit codes: `0` no errors; `1` permission errors, and nothing else; `2`
anything else: a usage or configuration error, a file that can't be read or
written, or an internal error. An internal error prints the error and where it
happened, to [report](https://github.com/PermLang/PermLang/issues).

With `--json`, `--github-annotations` prints the annotations on standard error,
so standard output stays valid JSON. GitHub Actions reads both.

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
See [docs/spec-format.md](spec-format.md).

## Real-world trial

[docs/trial-2026-09.md](trial-2026-09.md): PermLang on Umami (1,372 files, 22 s)
and Ghostfolio's API (524 files, 9 s). It found and fixed four false-positive
classes and one false-negative class (Prisma clients built with `$extends`),
found no false positives in a spot check of its network, process, and file-write
findings, and identified the main remaining false negative: SDKs without
adapters. Run `prisma generate` before PermLang in CI, or database access is
invisible.

## Development

Tests come first. Each detection rule gets passing and failing fixtures
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
src/detect/         direct uses: fetch, fs, env, Prisma, Drizzle, SQL, adapter-mapped calls, values, unverifiable code
src/dispatch.ts     implementations reachable through interfaces and base classes
src/units.ts        functions, methods, and files that permissions attach to
src/graph.ts        the call graph and propagation along it
src/unmapped.ts     packages with no adapter, and imports with no types
src/project-files.ts workflows, Actions, and package.json scripts, as lock entries
src/tools.ts        tool registrations for AI models, and their handlers
src/flows.ts        data-flow rules: parsing, and finding functions that break them
src/deps.ts         new dependencies in a change
src/check.ts        comparing declared vs. actual per unit
src/lock.ts         permlang.lock.json: build, read, compare
src/settings.ts     what the check runs with (config, options, files), as lock entries
src/diff.ts         the permission diff, as text or a pull-request comment
src/report.ts       text, JSON, GitHub annotation, and SARIF output
src/main.ts         the permlang command: its subcommands and options
src/cli.ts          the executable that runs it
src/index.ts        the library API
src/spec/           .perm specs: parsing and checking
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
