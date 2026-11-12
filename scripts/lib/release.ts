/**
 * The release's git step (ADR 30): turn the built `dist/plugin/` into one commit on the `plugin` branch, whose
 * root is the plugin, so that the marketplace entry `{ source: github, ref: plugin }` installs it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Throws unless `tag` is `v<version>` and the version is semver. */
export function checkReleaseTag(tag: string, version: string): void {
  if (!SEMVER.test(version)) throw new Error(`version ${version} is not semver`);
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match the version ${version}`);
}

export interface PluginCommit {
  /** The git repository the commit is written to. */
  repo: string;
  /** The built plugin folder: it becomes the commit's whole tree. */
  tree: string;
  version: string;
  /** The branch tip the commit goes on from, when it exists (e.g. `refs/remotes/origin/plugin`). */
  parentRef: string;
  /** The source commit, named in the message. */
  source: string;
  /** Extra environment for git, such as the author. */
  env?: Record<string, string>;
}

/**
 * Write `tree` as one commit and return its sha; no ref, index or work tree of `repo` changes. The tree is
 * added with a temporary index and `--force`, so no ignore rule drops a built file; file modes are kept.
 * Throws when the folder is not the plugin of `version`, or when the branch tip already holds this tree.
 */
export function commitPluginTree(options: PluginCommit): string {
  const { repo, tree, version, parentRef, source } = options;
  const manifestPath = join(tree, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`${tree} has no .claude-plugin/plugin.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (manifest.version !== version)
    throw new Error(`plugin.json has version ${String(manifest.version)}, not ${version}`);

  const scratch = mkdtempSync(join(tmpdir(), "qx-release-index-"));
  try {
    const env = { ...process.env, ...options.env, GIT_INDEX_FILE: join(scratch, "index") };
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
    git(`--work-tree=${tree}`, "add", "--all", "--force", ".");
    const treeSha = git("write-tree");
    const parent = tipOf(git, parentRef);
    if (parent !== undefined && git("rev-parse", `${parent}^{tree}`) === treeSha) {
      throw new Error("the plugin branch already holds this tree");
    }
    const message = `quantext ${version}\n\nBuilt from ${source} by the release workflow.\n`;
    return git("commit-tree", treeSha, ...(parent === undefined ? [] : ["-p", parent]), "-m", message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The commit `ref` names, or undefined when there is no such ref (the first release). */
function tipOf(git: (...args: string[]) => string, ref: string): string | undefined {
  try {
    return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined; // --quiet: no such ref
    throw error;
  }
}
