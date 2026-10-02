// New dependencies in a change. A package added to package.json can do anything its
// code does, and PermLang only sees inside it if an adapter describes it. So the
// permission diff lists each new package, what PermLang knows about it, and the
// install scripts that run when it's installed.

import type { AdapterIndex } from "./adapters.js";
import { isDetectedPackage } from "./unmapped.js";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DependencyChange {
  name: string;
  version: string;
  dev: boolean;
  /** adapter: its calls are mapped; pure: touches nothing tracked; detected: built-in detection; unknown: not checked. */
  known: "adapter" | "pure" | "detected" | "unknown";
  /** Whether it's installed here, so its install scripts could be read. */
  installed: boolean;
  /** `preinstall`, `install`, and `postinstall` scripts, as `name: command`; undefined when not installed. */
  installScripts?: string[];
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** Packages in `head` that `base` doesn't have, in either dependencies or devDependencies. */
export function addedDependencies(
  base: PackageJson | undefined,
  head: PackageJson,
  adapters: AdapterIndex,
  readInstalled: (name: string) => PackageJson | undefined,
): DependencyChange[] {
  // Without a base package.json (a new project), everything would be "new": not useful.
  if (!base) return [];
  const before = new Set([...Object.keys(base.dependencies ?? {}), ...Object.keys(base.devDependencies ?? {})]);
  const out: DependencyChange[] = [];
  for (const [field, dev] of [["dependencies", false], ["devDependencies", true]] as const) {
    for (const [name, version] of Object.entries(head[field] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (before.has(name) || out.some((d) => d.name === name)) continue;
      const pkg = readInstalled(name);
      const scripts = pkg ? INSTALL_SCRIPTS.filter((s) => pkg.scripts?.[s]).map((s) => `${s}: ${pkg.scripts![s]}`) : undefined;
      out.push({
        name,
        version,
        dev,
        known: adapters.isPure(name) ? "pure" : adapters.hasPackage(name) ? "adapter" : isDetectedPackage(name) ? "detected" : "unknown",
        installed: pkg !== undefined,
        ...(scripts ? { installScripts: scripts } : {}),
      });
    }
  }
  return out;
}
