# Getting started with PermLang

This takes an existing TypeScript project from nothing to a pull-request check
that shows new access, in about ten minutes. You don't need to annotate
anything to start.

> PermLang is pre-release. The repository and GitHub Action are private to the
> PermLang organization for now.

## 1. Install

```bash
npm install --save-dev permlang
```

Until the first release is published, install from a checkout of the repository
instead: run `npm pack` there, then `npm install --save-dev ./permlang-0.1.0-dev.tgz`.

PermLang reads your code through the TypeScript compiler. It needs the same
types your build uses:

- **`@types/node`**, or Node built-ins like `fs` and `child_process` are
  invisible. PermLang reports any import whose types it can't find (PERM007).
- **A generated Prisma client**, if you use Prisma: run `prisma generate` first,
  or database access is invisible.

## 2. Set up

```bash
npx permlang init src --workflow
```

Use `--project tsconfig.json` instead of `src` to check a TypeScript project's files.

This writes three files. Commit all of them:

| File | What it is |
| --- | --- |
| `permlang.config.json` | Settings. Starts at `"strictness": "sketch"`: everything is reported, and nothing fails yet. |
| `permlang.lock.json` | What every function can reach today: network hosts, files, database tables, environment variables, processes. |
| `.github/workflows/permlang.yml` | Runs PermLang on every pull request and comments the permission diff. |

## 3. Review what you have

```bash
npx permlang check src
```

Look at three things:

- **Packages with no adapter.** PermLang can't see what these touch, so it
  trusts them. Each gets one warning (PERM006). For each one, either add an
  adapter (see the README's "Adapter manifests") or declare it pure. A small
  team adapter file, listed under `"adapters"` in `permlang.config.json`, does
  either.
- **Unverifiable code** (PERM004): `eval`, `new Function`, computed calls on
  `fs` or `globalThis`, `require` of a computed path. Rewrite it, or mark the
  function `@perm-unsafe reason:"..."`. Every override is listed in every report.
- **The lock file.** It's the inventory of what your code can touch. Anything
  surprising in it is worth a look now.

## 4. Work with the lock

From now on, when a change gives code new access, `permlang check` fails:

```
src/leads.ts:8:1 error PERM005: handleLead can now reach net(api.data-broker.io), which permlang.lock.json doesn't record.
  -> run `permlang lock` and commit the change so reviewers see it.
```

If the access is intended, run `npx permlang lock` and commit the lock change.
Reviewers see it in the pull request, and the Action's comment shows where the
new access happens and which functions can now reach it:

```bash
npx permlang diff origin/main
```

## 5. Enforce, when you're ready

Annotations make the rules explicit. Add `@perm` to the functions that matter,
starting with entry points like route handlers, jobs, and public APIs:

```ts
/** @perm net(api.stripe.com), db.write(payment), env(STRIPE_KEY) */
export async function charge(order: Order) { ... }
```

A whole file can share one declaration:

```ts
/**
 * @module
 * @perm net(api.stripe.com)
 */
```

Then raise `"strictness"` in `permlang.config.json`:

- `development`: annotated functions can't exceed their `@perm`, and exported
  functions must declare what they reach.
- `production`: every function must be covered, private helpers included.

Set `"unmapped": "error"` to require every package to be mapped or declared pure.

## Reference

- Capabilities and matching rules, adapters, and known limits: [README](../README.md)
- What PermLang found on real projects: [trial report](trial-2026-09.md)
