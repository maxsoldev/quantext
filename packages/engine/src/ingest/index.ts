/** ingest: find transcripts, read new bytes, call the adapter, write each batch in one transaction; watch for changes. */

export type { CallsEvent, IngestEvent, LogRemovedEvent, MemoryEvent } from "@quantext/shared";
export type { LogFiles, PathError, SubagentFile } from "./discover.ts";
export { discoverLogs } from "./discover.ts";
export type { Ingest, IngestOptions, IngestSummary, RunOptions } from "./ingest.ts";
export { createIngest, DEFAULT_BATCH_BYTES } from "./ingest.ts";
export { claudeConfigDir } from "./paths.ts";
export type { ChangeSource, FsChangesOptions, Watcher, WatchOptions } from "./watch.ts";
export { fsChanges, watchTranscripts } from "./watch.ts";
