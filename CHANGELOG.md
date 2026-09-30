# Changelog

All notable changes to PermLang. The project is pre-release; v0.1.0 has not been
published.

## Unreleased (v0.1.0)

### Added

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
