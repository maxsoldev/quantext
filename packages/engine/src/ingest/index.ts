/** ingest: find transcripts, read new bytes, call the adapter, write each batch in one transaction; watch for changes. */
export type { LogFiles, PathError, SubagentFile } from "./discover.ts";
export { discoverLogs } from "./discover.ts";
export type { CallsEvent, Ingest, IngestOptions, IngestSummary } from "./ingest.ts";
export { createIngest, DEFAULT_BATCH_BYTES } from "./ingest.ts";
