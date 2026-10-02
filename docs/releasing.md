# Releasing PermLang

The npm package is `permlang`, owned by the npm user `parkweb`, with the
`@permlang` scope reserved by the `permlang` org.

## Making a release

1. Merge a PR that bumps `version` in `package.json` (and `package-lock.json`)
   and dates the `CHANGELOG.md` section.
2. On GitHub, create a release with the tag `v<version>` (for example `v0.2.1`)
   on `main`.

The [release workflow](../.github/workflows/release.yml) checks that the tag
matches `package.json`, runs the tests, publishes to npm with provenance, and
moves the `v0` tag. A new version can take a few minutes to download from npm
after the workflow finishes.

## Choosing the version

Before 1.0, the minor version marks changes that can fail builds that passed
before:

- **Patch** (`0.2.0` → `0.2.1`): fixes and new detection that don't make
  previously passing code fail, plus docs.
- **Minor** (`0.2.x` → `0.3.0`): anything that can make previously passing code
  fail, such as detecting a new kind of access. Say so at the top of the
  changelog section.

npm users on `^0.2.0` only get patches. Action users on `@v0` get every 0.x
release, minors included, because the workflow moves `v0` each time. The
reference tells users to pin an exact tag (`@v0.2.0`) if they don't want that.

## One-time setup (done for 0.1.0, 2026-10-01)

npm's trusted publishing can only be set up on a package that already exists,
so 0.1.0 was published by hand (`npm login`, then `npm publish --access public`
from a clean `main`). The package's npm settings then got a Trusted Publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `PermLang` |
| Repository | `permlang` |
| Workflow filename | `release.yml` |
| Environment | *(empty)* |
| Allowed actions | **Allow `npm publish`** ticked |

Without **Allow `npm publish`**, npm only lets the workflow stage a release, and
publishing fails with `OIDC permission denied for this action`.

**Publishing access** is set to "Require two-factor authentication and disallow
tokens", so only the workflow, or a person with 2FA, can publish.
