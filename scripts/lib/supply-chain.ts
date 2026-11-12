/**
 * Supply-chain checks on text (SECURITY.md, "How we keep dependencies safe"): where the lockfile's packages
 * come from, the pnpm-workspace.yaml security settings, install scripts against allowBuilds, licences against
 * the allowlist, and the THIRD_PARTY_NOTICES text. Each returns the problems it found; none means pass.
 */

const REGISTRY = "https://registry.npmjs.org/";

/** Licences we accept for shipped (bundled) code: permissive, no copyleft. SPDX ids. */
export const LICENCE_ALLOWLIST = [
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "CC-BY-4.0",
];

/** Lockfile packages that do not come from registry.npmjs.org with an integrity hash, and importers by URL. */
export function lockfileProblems(text: string): string[] {
  const problems: string[] = [];
  let section = "";
  let key: string | undefined;
  let importerDep: string | undefined;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) section = line.replace(/:.*$/, "");
    if (section === "packages") {
      const entry = /^ {2}'?([^\s'][^']*?)'?:\s*$/.exec(line);
      if (entry) key = entry[1];
      const resolution = /^ {4}resolution: \{(.*)\}\s*$/.exec(line);
      if (resolution && key !== undefined) problems.push(...resolutionProblems(key, resolution[1] ?? ""));
    }
    if (section === "importers") {
      const dep = /^ {6}'?([^\s'][^']*?)'?:\s*$/.exec(line);
      if (dep) importerDep = dep[1];
      const spec = /^ {8}specifier: (.+)$/.exec(line);
      if (spec && !isRegistrySpecifier(spec[1]?.trim() ?? "")) {
        problems.push(`importer dependency ${importerDep}: specifier ${spec[1]} is not a registry version`);
      }
    }
  }
  return problems;
}

function resolutionProblems(key: string, body: string): string[] {
  if (/\btype: (git|directory)\b|\bdirectory:|\brepo:/.test(body)) return [`${key}: resolved from git or a folder`];
  const tarball = /\btarball: ([^,}\s]+)/.exec(body)?.[1];
  if (tarball !== undefined && !tarball.startsWith(REGISTRY))
    return [`${key}: resolved from ${tarball}, not registry.npmjs.org`];
  if (!/\bintegrity: sha512-/.test(body)) return [`${key}: no integrity hash`];
  return [];
}

/** An exact version, a range, `workspace:` or an npm alias; not a URL, git, GitHub, file or link. */
function isRegistrySpecifier(spec: string): boolean {
  const s = spec.replace(/^['"]|['"]$/g, "");
  if (s.startsWith("workspace:")) return true;
  return !/^(?:[a-z+]+:|\.{0,2}\/)/i.test(s) || s.startsWith("npm:");
}

/** The security settings pnpm-workspace.yaml must keep, and a comment on every allowBuilds and exclude entry. */
export function workspaceProblems(text: string): string[] {
  const problems: string[] = [];
  const value = (name: string) => new RegExp(`^${name}:\\s*(.*?)\\s*(?:#.*)?$`, "m").exec(text)?.[1];
  const wanted: [string, string][] = [
    ["saveExact", "true"],
    ["strictDepBuilds", "true"],
    ["trustPolicy", "no-downgrade"],
    ["blockExoticSubdeps", "true"],
  ];
  for (const [name, want] of wanted) if (value(name) !== want) problems.push(`${name} must be ${want}`);
  if (!(Number(value("minimumReleaseAge")) >= 1440)) problems.push("minimumReleaseAge must be at least 1440");
  if (value("allowBuilds") === undefined) problems.push("allowBuilds must be stated (allowBuilds: {})");
  for (const block of ["allowBuilds", "trustPolicyExclude"]) {
    for (const entry of entriesWithoutComment(text, block)) {
      problems.push(`${block} entry ${entry} has no comment with its reason`);
    }
  }
  return problems;
}

/** The entries of a top-level YAML block (`name:` then indented lines) with no comment above or after them. */
function entriesWithoutComment(text: string, name: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i] ?? ""); i++) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("#")) continue;
    const commented = line.includes(" #") || (lines[i - 1] ?? "").trim().startsWith("#");
    if (!commented) out.push(line.replace(/^-\s*/, "").replace(/:.*$/, ""));
  }
  return out;
}

export interface InstalledPackage {
  name: string;
  version: string;
  scripts: Record<string, string>;
  /** Has a binding.gyp: npm and pnpm run `node-gyp rebuild` for it even with no install script. */
  gyp: boolean;
}

/** Installed packages that would run code at install time without an allowBuilds entry. */
export function buildScriptProblems(pkgs: InstalledPackage[], allowBuilds: string[]): string[] {
  const problems: string[] = [];
  for (const p of pkgs) {
    if (allowBuilds.includes(p.name)) continue;
    const script = ["preinstall", "install", "postinstall"].find((s) => p.scripts[s] !== undefined);
    if (script !== undefined) problems.push(`${p.name}@${p.version} has a ${script} script and no allowBuilds entry`);
    else if (p.gyp) problems.push(`${p.name}@${p.version} has a native build (binding.gyp) and no allowBuilds entry`);
  }
  return problems;
}

/** True when an SPDX expression is satisfied by allowed licences: one OR branch whose AND parts all are. */
export function licenceAllowed(expression: string, allow: string[]): boolean {
  const flat = expression.replace(/[()]/g, " ").trim();
  return flat.split(/\s+OR\s+/).some((branch) => branch.split(/\s+AND\s+/).every((id) => allow.includes(id.trim())));
}

export interface LicensedPackage {
  name: string;
  version: string;
  license: string;
}

/**
 * Font licences, accepted only for font packages. OFL-1.1 allows bundling and redistribution with the licence text
 * (THIRD_PARTY_NOTICES carries it) but not selling the font alone, so it fits a font and nothing else.
 */
const FONT_LICENCES = ["OFL-1.1"];
const isFontPackage = (name: string) => /^@fontsource(-variable)?\//.test(name);

export function licenceProblems(pkgs: LicensedPackage[], allow: string[]): string[] {
  return pkgs
    .filter((p) => !licenceAllowed(p.license, isFontPackage(p.name) ? [...allow, ...FONT_LICENCES] : allow))
    .map((p) => `${p.name}@${p.version}: ${p.license} is not on the licence allowlist`);
}

/** THIRD_PARTY_NOTICES.md for the plugin: each bundled package, its licence and its licence text. */
export function notices(pkgs: (LicensedPackage & { text: string | undefined })[]): string {
  if (pkgs.length === 0) {
    return "# Third-party notices\n\nThe plugin bundles no third-party packages: the engine, the mod and the viewer are Quantext's own code.\n";
  }
  const head =
    "# Third-party notices\n\nThe Quantext plugin bundles the packages below, each with its licence and the licence text it ships.\n";
  const sections = [...pkgs]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((p) => `## ${p.name} ${p.version} (${p.license})\n\n${p.text?.trim() ?? "No licence file in the package."}\n`);
  return `${head}\n${sections.join("\n")}`;
}
