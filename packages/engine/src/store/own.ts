/** Tell a Quantext store from another program's SQLite file before anything writes to it. */
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { RawDatabase } from "./driver.ts";
import { openRaw } from "./driver.ts";
import { SCHEMA_VERSION } from "./schema.ts";

/** `quantext.db` is not a store this engine made: it is left as it is, and the user is told to move it aside. */
export class ForeignDatabaseError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(
      `${path} is not a Quantext database (${reason}). Quantext does not change it: move it aside ` +
        `(for example \`mv "${path}" "${path}.old"\`) and start again`,
    );
    this.name = "ForeignDatabaseError";
    this.path = path;
  }
}

/** Tables that every schema version of the store has, with a column each, as a marker beside `schema_version`. */
const MARKERS: readonly [string, string][] = [
  ["logs", "adapter_version"],
  ["ingest_files", "byte_offset"],
  ["calls", "framing_tokens"],
  ["call_blocks", "first_call"],
];

/**
 * Throw ForeignDatabaseError when the file at `path` holds tables but is no Quantext store: no `schema_version`
 * with one positive version, or a missing marker table; throw when its version is newer than this engine's.
 * Reads it read-only; a missing or empty file passes (a new store).
 */
export async function refuseForeign(path: string): Promise<void> {
  const size = statOrUndefined(path)?.size ?? 0;
  if (size === 0) return;
  // immutable: SQLite reads only the main file, takes no lock and makes no -wal or -shm file next to it.
  const db = await openRaw(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true }).catch((error: unknown) => {
    throw new ForeignDatabaseError(path, `it cannot be read as SQLite: ${String(error)}`);
  });
  try {
    const reason = foreignReason(db);
    if (reason !== undefined) throw new ForeignDatabaseError(path, reason);
  } catch (error) {
    if (error instanceof ForeignDatabaseError || error instanceof NewerStoreError) throw error;
    throw new ForeignDatabaseError(path, `it cannot be read as SQLite: ${String(error)}`);
  } finally {
    db.close();
  }
}

function foreignReason(db: RawDatabase): string | undefined {
  const prepare = (sql: string) => db.prepare(sql);
  const tables = new Set(
    prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r.name)),
  );
  if (tables.size === 0) return undefined;
  if (!tables.has("schema_version")) return "it has tables but no schema version";
  const versions = prepare("SELECT version FROM schema_version").all();
  const version = versions[0]?.version;
  const known = typeof version === "number" || typeof version === "bigint";
  if (versions.length !== 1 || !known || !Number.isInteger(Number(version)) || Number(version) < 1) {
    return "its schema version is not one Quantext writes";
  }
  if (Number(version) > SCHEMA_VERSION) throw new NewerStoreError(Number(version));
  for (const [table, column] of MARKERS) {
    const has = tables.has(table) && prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
    if (has === false || has === undefined) return `it has no ${table}.${column}`;
  }
  return undefined;
}

/** The store is of a newer engine: this one must not read or change it. */
class NewerStoreError extends Error {
  constructor(version: number) {
    super(`the database's schema version ${version} is newer than this engine's (${SCHEMA_VERSION})`);
  }
}

function statOrUndefined(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
