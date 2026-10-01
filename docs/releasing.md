# Releasing PermLang

The npm package is `permlang`, owned by the npm user `parkweb`, with the
`@permlang` scope reserved by the `permlang` org.

## Before the first release

1. The external security review is done, and its findings are fixed.
2. A trademark search for "PermLang" is done.
3. A release PR is merged that:
   - sets `"version": "0.1.0"` and removes `"private": true` from `package.json`;
   - dates the `CHANGELOG.md` section;
   - changes `PermLang/permlang@main` to `PermLang/permlang@v0` in the docs.
4. The repository is public (the Action and provenance need it).

## First release (manual, once)

npm's trusted publishing can only be set up on a package that exists, so the
first version is published by hand, from a clean checkout of `main`:

```bash
npm login
npm publish --access public
```

`prepublishOnly` runs the typecheck, tests, and build first. npm asks for a
2FA code.

Then, on npmjs.com, open the `permlang` package → **Settings** → **Trusted
Publisher** → **GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `PermLang` |
| Repository | `permlang` |
| Workflow filename | `release.yml` |

After that, set **Publishing access** to "Require two-factor authentication and
disallow tokens", so only the workflow can publish.

Finally, create the GitHub release `v0.1.0` on that commit. The release workflow
sees that 0.1.0 is already on npm, skips publishing, and creates the `v0` tag
the Action is used by.

## Later releases

1. Merge a PR that bumps `version` in `package.json` and dates the changelog.
2. On GitHub, create a release with the tag `v<version>` (for example `v0.1.1`).

The [release workflow](../.github/workflows/release.yml) checks that the tag
matches `package.json`, runs the tests, publishes to npm with provenance, and
moves the `v0` tag so Action users get the update.
