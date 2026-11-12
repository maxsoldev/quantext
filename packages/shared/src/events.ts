/**
 * Change events. Ingest gives `IngestEvent`s, which name the harness's folders; the API's SSE passes each through
 * the query layer's `publicEvent`, which gives a `PublicEvent` (Session keys and projects, no log folders) or
 * nothing. Each carries the store's change cursor after its write.
 */
import type { SessionKey } from "./query.ts";

/** Calls one write added or updated in one Session; both lists are empty when only the Session itself changed. */
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
}

export type IngestEvent = CallsEvent | MemoryEvent | LogRemovedEvent;

/** A change event as the API sends it: Session keys and projects, no log folders. */
export type PublicEvent =
  /** Empty `added` and `updated`: the Session changed (its end, title, events) with no Call added or updated. */
  | {
      kind: "calls";
      cursor: number;
      session: SessionKey;
      added: { id: string; index: number }[];
      updated: string[];
    }
  /** `projects`: as `SessionSummary.project` shows them. */
  | { kind: "memory"; cursor: number; projects: string[] }
  | { kind: "log-removed"; cursor: number; logId: number };
