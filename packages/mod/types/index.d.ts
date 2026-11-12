/** The mod's values in `$.state`: what the session has shown so far. They survive a reload of the module. */
export type Live = {
  /** The harness's own session cost, from `session.measure`; undefined where it keeps no ledger. */
  usd?: number;
  /** Input tokens of the last response (all of it: uncached, cache-written, cache-read); 0 before the first. */
  ctx: number;
  /** Main-loop totals over the session, for the cache hit rate. */
  read: number;
  input: number;
  /** When the last main-loop call ended (ms since the epoch), and its input size; 0 before the first. */
  lastEndAt: number;
  lastCtx: number;
  /** Whether the large-context nudge was shown since the last compaction or /clear. */
  bigCtxNudged: boolean;
};

declare module "claude-code" {
  interface PluginState {
    quantext: { live: Live };
  }
}
