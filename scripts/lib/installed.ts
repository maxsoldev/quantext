/**
 * What is installed, for the supply-chain checks: the licences pnpm reports (`pnpm licenses list`), and each
 * package folder under node_modules/.pnpm with its install scripts. pnpm is the one that runs this script
 * (npm_execpath), so the pinned version answers.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledPackage, LicensedPackage } from "./supply-chain.ts";

export type Licensed = LicensedPackage & { path: string | undefined };

/**
 * Run the pinned pnpm (package.json `packageManager`) with `args` in `repo`; its stdout. A nested `pnpm` in a
 * script can be an older global one, which cannot read the lockfile, so each candidate's version is checked.
 */
export function pnpm(repo: string, args: string[]): string {
  const pinned = /^pnpm@([^+]+)/.exec(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager)?.[1];
  const exec = process.env.npm_execpath;
  const candidates: string[][] = [
    ...(exec === undefined ? [] : [/\.[cm]?js$/.test(exec) ? [process.execPath, exec] : [exec]]),
    ["pnpm"],
    ["corepack", "pnpm"],
  ];
  const run = ([command, ...pre]: string[], a: string[]) =>
    execFileSync(command ?? "pnpm", [...pre, ...a], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const candidate of candidates) {
    let version: string;
    try {
      version = run(candidate, ["--version"]).trim();
    } catch {
      continue; // not installed: try the next one
    }
    if (version === pinned) return run(candidate, args);
  }
  throw new Error(`no pnpm ${pinned} found (tried npm_execpath, pnpm, corepack pnpm)`);
}

/** Every installed package with its licence; `prod` limits it to dependencies (what the plugin bundles). */
export function licensed(repo: string, prod: boolean): Licensed[] {
  const report = JSON.parse(pnpm(repo, ["licenses", "list", "--json", "-r", ...(prod ? ["--prod"] : [])])) as Record<
    string,
    { name: string; versions: string[]; paths?: string[]; license?: string }[]
  >;
  return Object.entries(report).flatMap(([license, pkgs]) =>
    pkgs.flatMap((p) => p.versions.map((version, i) => ({ name: p.name, version, license, path: p.paths?.[i] }))),
  );
}

/** The licence file a package ships (LICENSE, LICENCE, COPYING, …), or undefined. */
export function licenceText(path: string | undefined): string | undefined {
  if (path === undefined || !existsSync(path)) return undefined;
  const file = readdirSync(path).find((n) => /^(licen[cs]e|copying)(\.|-|$)/i.test(n));
  return file === undefined ? undefined : readFileSync(join(path, file), "utf8");
}

/** Each package folder in node_modules/.pnpm, with its scripts and whether it has a binding.gyp. */
export function installedPackages(repo: string): InstalledPackage[] {
  const store = join(repo, "node_modules", ".pnpm");
  const out: InstalledPackage[] = [];
  for (const entry of existsSync(store) ? readdirSync(store) : []) {
    const modules = join(store, entry, "node_modules");
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      const names = name.startsWith("@") ? readdirSync(join(modules, name)).map((n) => `${name}/${n}`) : [name];
      for (const n of names) {
        const manifest = join(modules, n, "package.json");
        // Links to other entries' packages are visited under their own entry.
        if (!existsSync(manifest) || !entry.startsWith(`${n.replace("/", "+")}@`)) continue;
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          version?: string;
          scripts?: Record<string, string>;
        };
        out.push({
          name: n,
          version: pkg.version ?? "?",
          scripts: pkg.scripts ?? {},
          gyp: existsSync(join(modules, n, "binding.gyp")),
        });
      }
    }
  }
  return out;
}
