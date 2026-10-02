// New dependencies in the permission diff: a package added in a pull request can do
// anything, so the comment lists it, what PermLang knows about it, and its install scripts.

import { describe, expect, it } from "vitest";
import { AdapterIndex, loadAdapters } from "../src/adapters.js";
import { addedDependencies, type PackageJson } from "../src/deps.js";

const adapters = new AdapterIndex(loadAdapters([]).adapters);
const installed: Record<string, PackageJson> = {
  "sketchy-telemetry": { scripts: { postinstall: "node collect.js", test: "vitest" } },
  zod: {},
};
const read = (name: string) => installed[name];

describe("new dependencies", () => {
  const base: PackageJson = { dependencies: { zod: "^3.0.0" }, devDependencies: { typescript: "^5.0.0" } };
  const head: PackageJson = {
    dependencies: { zod: "^3.0.0", stripe: "^22.0.0", "sketchy-telemetry": "1.0.0", pg: "^8.0.0" },
    devDependencies: { typescript: "^5.0.0", "date-fns": "^4.0.0", "not-installed": "^1.0.0" },
  };
  const added = addedDependencies(base, head, adapters, read);

  it("lists only packages the base didn't have, dependencies first", () => {
    expect(added.map((d) => `${d.name}${d.dev ? " (dev)" : ""}`)).toEqual(["pg", "sketchy-telemetry", "stripe", "date-fns (dev)", "not-installed (dev)"]);
  });

  it("says what PermLang knows about each one", () => {
    const known = Object.fromEntries(added.map((d) => [d.name, d.known]));
    expect(known).toEqual({ pg: "detected", "sketchy-telemetry": "unknown", stripe: "adapter", "date-fns": "pure", "not-installed": "unknown" });
  });

  it("lists install scripts when the package is installed, and says when it isn't", () => {
    const scripts = Object.fromEntries(added.map((d) => [d.name, d.installScripts]));
    expect(scripts["sketchy-telemetry"]).toEqual(["postinstall: node collect.js"]);
    expect(scripts["not-installed"]).toBeUndefined();
    expect(added.find((d) => d.name === "stripe")!.installed).toBe(false);
  });

  it("reports nothing without a base package.json, or when nothing was added", () => {
    expect(addedDependencies(undefined, head, adapters, read)).toEqual([]);
    expect(addedDependencies(head, head, adapters, read)).toEqual([]);
  });

  it("counts a package moved from devDependencies to dependencies as not new", () => {
    expect(addedDependencies({ devDependencies: { zod: "^3.0.0" } }, { dependencies: { zod: "^3.0.0" } }, adapters, read)).toEqual([]);
  });
});
