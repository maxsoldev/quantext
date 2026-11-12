/**
 * Change events. Ingest gives `IngestEvent`s, which may name local paths; a reader (the API's SSE) passes each
 * through the query layer's `visibleEvent`, which gives a `VisibleEvent` or nothing (a hidden project in demo mode).
 * Each carries the store's change cursor after its write.
 */
import type { SessionKey } from "./query.ts";

/** Calls one write added or updated in one Session. */
export interface CallsEvent {
  kind: "calls";
  /** The log's id in the store: with `sessionId`, the Session's key. */
  logId: number;
  cursor: number;
  sessionId: string;
  added: string[];
  /** The index of each added Call, in the order of `added`. */
  addedIndexes: number[];
  updated: string[];
}

/** Project memory documents were stored, changed or removed. */
export interface MemoryEvent {
  kind: "memory";
  cursor: number;
  /** The harness's folders of the projects whose memory changed. */
  projectDirs: string[];
}

/** A log's rows were deleted (to be read again from the start). */
export interface LogRemovedEvent {
  kind: "log-removed";
  logId: number;
  cursor: number;
  /** The projects of its Sessions before they were deleted. */
  projects: string[];
}

export type IngestEvent = CallsEvent | MemoryEvent | LogRemovedEvent;

/** A change event as a reader may see it: no local paths, nothing of a hidden project. */
export type VisibleEvent =
  | {
      kind: "calls";
      cursor: number;
      session: SessionKey;
      added: { id: string; index: number }[];
      updated: string[];
    }
  /** `projects`: as `SessionSummary.project` shows them (folder names in demo mode). */
  | { kind: "memory"; cursor: number; projects: string[] }
  | { kind: "log-removed"; cursor: number; logId: number };
