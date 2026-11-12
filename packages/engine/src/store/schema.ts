/**
 * The store's schema, as forward-only migrations (docs/schema.md, ADR 19). Migration N takes a database at version
 * N - 1 to N. A released migration is never edited: change the schema with a new one.
 */
import type { SqlDriver } from "./driver.ts";

const V1 = `
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  snapshot TEXT
) STRICT;

CREATE TABLE ingest_files (
  path TEXT PRIMARY KEY,
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  transcript TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transcript', 'meta')),
  file_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  error TEXT
) STRICT;
CREATE INDEX ingest_files_log ON ingest_files (log);

CREATE TABLE sessions (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  harness TEXT NOT NULL,
  harness_version TEXT,
  project TEXT,
  cwd TEXT,
  started TEXT,
  ended TEXT,
  request_log TEXT NOT NULL CHECK (request_log IN ('present', 'partial', 'absent')),
  title TEXT,
  title_source TEXT,
  agent_name TEXT,
  PRIMARY KEY (log, id)
) STRICT;

CREATE TABLE calls (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  lane TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  canonical_model TEXT,
  params TEXT NOT NULL,
  shape_hash TEXT,
  usage_basis TEXT,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  speed TEXT,
  service_tier TEXT,
  inference_geo TEXT,
  cost_input_usd REAL,
  cost_cache_read_usd REAL,
  cost_cache_write_usd REAL,
  cost_output_usd REAL,
  cost_total_usd REAL,
  price_model TEXT,
  price_source TEXT,
  price_date TEXT,
  price_modifiers TEXT,
  block_count INTEGER,
  cache_breakpoints TEXT NOT NULL,
  cache_boundary_tokens INTEGER,
  cache_boundary_position INTEGER,
  framing_tokens INTEGER NOT NULL,
  issues TEXT NOT NULL,
  turn_duration_ms INTEGER,
  PRIMARY KEY (log, id),
  FOREIGN KEY (log, session_id) REFERENCES sessions (log, id)
) STRICT;
CREATE INDEX calls_session ON calls (log, session_id, idx);

CREATE TABLE blocks (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT,
  tool TEXT,
  file_path TEXT,
  mcp_server TEXT,
  skill TEXT,
  text TEXT
) STRICT;

CREATE TABLE log_blocks (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  hash TEXT NOT NULL REFERENCES blocks (hash),
  PRIMARY KEY (log, hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE call_blocks (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  block_hash TEXT NOT NULL REFERENCES blocks (hash),
  position INTEGER NOT NULL,
  section TEXT NOT NULL,
  message INTEGER,
  tokens INTEGER,
  basis TEXT,
  grp TEXT,
  first_call INTEGER NOT NULL,
  last_call INTEGER,
  PRIMARY KEY (log, id)
) STRICT;
CREATE INDEX call_blocks_interval ON call_blocks (log, session_id, lane, first_call, last_call);
CREATE INDEX call_blocks_block ON call_blocks (block_hash);

CREATE TABLE tool_calls (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  tool TEXT,
  file_path TEXT,
  mcp_server TEXT,
  skill TEXT,
  result_block_hash TEXT,
  is_error INTEGER NOT NULL,
  duration_ms REAL,
  parallel INTEGER NOT NULL,
  child_session_id TEXT,
  PRIMARY KEY (log, id)
) STRICT;
CREATE INDEX tool_calls_call ON tool_calls (log, call_id);

CREATE TABLE compactions (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  trigger TEXT NOT NULL,
  before_tokens INTEGER,
  after_tokens INTEGER,
  before_call_id TEXT,
  summary_call_id TEXT,
  PRIMARY KEY (log, id)
) STRICT;

CREATE TABLE messages (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  role TEXT NOT NULL,
  blocks TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT;

CREATE TABLE shapes (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  tools TEXT NOT NULL,
  system TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT;

CREATE TABLE records (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT;

CREATE TABLE session_events (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts TEXT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (log, id)
) STRICT;
CREATE INDEX session_events_session ON session_events (log, session_id, ts);

CREATE TABLE report_kinds (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'ignored')),
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (log, status, kind)
) STRICT;

CREATE TABLE report_unreadable (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (log, seq)
) STRICT;
`;

/** Migration i (0-based) takes the schema from version i to version i + 1. */
const MIGRATIONS: readonly string[] = [V1];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring the database to SCHEMA_VERSION, one transaction per migration. Returns the version. */
export function migrate(db: SqlDriver): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const current = Number(db.prepare("SELECT version FROM schema_version").get()?.version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`the database's schema version ${current} is newer than this engine's (${SCHEMA_VERSION})`);
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] ?? "");
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version + 1);
    });
  }
  return SCHEMA_VERSION;
}
