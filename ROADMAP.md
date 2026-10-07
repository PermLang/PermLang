# Roadmap

Where PermLang is going next. Plans change; the [changelog](CHANGELOG.md) says
what actually shipped, and [issues](https://github.com/PermLang/PermLang/issues)
are the place to ask for something.

## The project

- **A second maintainer.** Every change reviewed by someone other than its
  author, and someone besides the creator who can keep the project going
  ([GOVERNANCE.md](GOVERNANCE.md)). This comes first.
- **An independent security review** of PermLang's detection and its GitHub
  Action.
- **OpenSSF Baseline Level 3**, and the Best Practices badge at silver, then
  gold. Most of what's left needs the second maintainer.

## Next release (0.5)

- **AI tools in the lock.** A new tool an AI model can call shows in the
  pull-request comment today, but isn't recorded in the lock, so it doesn't fail
  the check on its own.
- **Tool handlers by name.** Report a tool's handler under the tool's name,
  rather than `<anonymous>.execute`.
- **JSX.** Count what a JSX element's component reaches when it's rendered.
- **Where a library sends requests.** Read the options that change it, such as
  an HTTP client's proxy or base URL.
- **Smaller detection gaps:** React DOM's `preinit` by its `as` option,
  nodemailer's SMTP host, a worker started from a URL in the same project, and
  a way to allow specific data flows.
- **Node 22 and later only.** Node 20 is past its end of life.
- **TypeScript 7.**

## 1.0

1.0 means the parts other tools and workflows depend on stop changing in ways
that break them: the lock file's format, the command line, the Action's inputs,
and the JSON and SARIF output. Before then, a minor version can still change
them ([docs/releasing.md](docs/releasing.md#choosing-the-version)).
