# Changelog

All notable changes to PermLang. The project is pre-release; v0.1.0 has not been
published.

## Unreleased (v0.1.0)

### Fixed (pre-release review)

An independent review before release found ways to reach capabilities with no
diagnostic. Each now has a regression fixture in `fixtures/m6/`:

- The `Function` constructor reached without naming it (`.constructor(...)`,
  `Function.apply`, `Reflect.construct(Function)`, values typed `Function`): PERM004.
- `.call`/`.apply`/`.bind` on a capability function (`fetch.call(...)`).
- URL templates whose port or userinfo came from a substitution could redirect
  to another host.
- `WebSocket`, `EventSource`, `navigator.sendBeacon`, `XMLHttpRequest`,
  `net.Socket#connect`, `http.ClientRequest`, `dgram`, `cluster`, `inspector`.
- Node's `http.request(url, { hostname })` options overriding the URL's host
  (new adapter placeholder `{host:N+}`).
- `process["env"]`.
- Setters, destructured getters, `obj["key"]` getters.
- Implicit calls: `await` (`then`), templates and string `+` (`toString`,
  `valueOf`, `Symbol.toPrimitive`), `for...of`, spreads, array destructuring.
- Exported code treated as private: `export default { ... }`, exported class
  expressions, namespaces, objects returned by exported functions.
- Casts trusted as values: string values are now traced (literals, consts, enum
  members, `as const` objects), never taken from a type.
- `permlang diff` now takes source paths (`diff <base> [paths...]`); the Action
  passes its `args`, doesn't glob-expand them, and doesn't fail on forks or when
  a comment can't be posted.
- `diff --lock` with an absolute path; a config file that isn't an object now
  exits 2.

### Fixed (second review)

A second independent review found more ways to get a wrong answer with no
diagnostic. Regression fixtures are in `fixtures/m8/`:

- The SQL table reader was rewritten to fail closed. It gave confident wrong
  answers for comma joins, quotes and comments inside names, MySQL `/*! */`
  comments, dollar quoting, and multiple statements. It now names tables only
  for statements it fully understands; anything else needs bare `db.read` and
  `db.write`.
- postgres.js fragments and helpers in a template (`${sql(table)}`, a
  fragment passed in) were read as bound values.
- Database client methods PermLang didn't list (`copyFrom`, `pragma`,
  `backup`, `sql.file`, ...) passed silently. They are now unknown database
  access; `loadExtension` is unverifiable (PERM004).
- Drizzle table names were guessed from variable names when the real name
  couldn't be read. Nested `with` relations and `migrate()` were missed.
- Text from code in the PR comment could inject Markdown or HTML; it is now
  escaped.
- Specs: an indented `perm` header was silently read as content, a second
  `implements:` replaced the first, and paths were matched case-insensitively
  on Linux.
- PERM007 missed `import x = require("x")`, literal `import("x")`, and
  packages shimmed with `declare module "x";`, whose calls are all `any`.
- The Action's hash step failed on macOS runners (no `sha256sum`), and could
  update a comment that wasn't its own.

### Added

- **Specs (phase 2 groundwork).** A `.perm` file format for rules, examples, and
  permissions (`docs/spec-format.md`), and `permlang spec`, which checks each
  spec's permissions against its implementation (SPEC001 to SPEC004). Rules and
  examples are parsed and reported as not yet verified.
- **Database clients beyond Prisma.** Drizzle (the table name comes from its
  `pgTable` / `mysqlTable` / `sqliteTable` definition) and raw SQL clients: `pg`,
  `mysql2`, `better-sqlite3`, `sqlite3`, `postgres`, Neon, and Vercel Postgres. Tables
  are read out of literal SQL; SQL built from strings needs bare `db.read` and
  `db.write`. Checked against the real packages' typings.
- **License: Apache 2.0** (`LICENSE`, `NOTICE`).
- **Package coverage.**
  - Every package called is now mapped by an adapter, declared pure
    (`adapters/pure.json`), or reported with a warning (PERM006).
    `"unmapped": "warn" | "error" | "trust"` sets the policy.
  - Imports whose types can't be found are reported (PERM007).
  - New built-in adapters: `node-fetch`, `undici`, Redis, Kafka, Bull/BullMQ,
    ClickHouse, AI SDKs, MCP, several web APIs, `@nestjs/config`, `maxmind`,
    `tar`, `dns`, `process`.
- **`permlang init`**: a sketch-level config, a first lock file, and with
  `--workflow` the GitHub workflow.
- **Programmatic API** (`import { checkFiles } from "permlang"`).
- **Getting-started guide** (`docs/getting-started.md`).

### Milestones

- **M5**:
  - strictness levels (sketch, development, production);
  - `permlang.lock.json` and `permlang lock`;
  - PERM005 when code gains access the lock doesn't record;
  - `permlang diff` as text, JSON, or a pull-request comment;
  - the GitHub Action;
  - a real-world trial on Umami and Ghostfolio (`docs/trial-2026-09.md`), with fixes:
    - `const` records in computed calls;
    - `require()` of harmless modules;
    - Prisma clients built with `$extends`;
    - relative module augmentations.
- **M4**:
  - an adversarial suite: functions used as values, interface and override
    dispatch, constructors and field initializers, computed calls, module side
    effects;
  - unverifiable code (PERM004): `eval`, `new Function`, computed calls on
    sensitive objects, `require`, `import(variable)`, `vm`, workers;
  - known limits as fixtures that fail once fixed.
- **M3**:
  - `env`, `exec`, `db` (Prisma), and `http`/`https`/`net`/`tls` detection;
  - adapter manifests, with built-ins for axios, Stripe, and nodemailer;
  - `@perm-unsafe`.
- **M2**:
  - propagation through the call graph across files, with call paths in errors;
  - module-level `@perm`.
- **M1**:
  - `@perm` annotations;
  - direct `fetch` and `fs` detection;
  - `permlang check`.
