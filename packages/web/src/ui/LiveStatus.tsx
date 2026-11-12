import type { IngestStatus } from "@quantext/shared";
import { percent } from "../format/format.ts";
import { useLiveState } from "../live/hooks.ts";

/** The engine connection and its ingest, in the masthead: one word, a dot, and progress while catching up. */
export function LiveStatus() {
  const s = useLiveState();
  const catching = s.ingest?.phase === "catching-up";
  const [word, tone, tip] =
    s.connection === "open"
      ? catching
        ? ["Catching up…", "busy", "The engine is reading session logs it has not read yet. Calls appear as it goes."]
        : ["Live", "good", "Connected to the engine. New calls appear as the harness writes them."]
      : s.connection === "connecting"
        ? ["Connecting…", "busy", "Opening the event stream to the engine."]
        : ["Reconnecting…", "bad", "The event stream dropped. The viewer opens it again and resumes where it was."];
  return (
    <div className="live-status" data-testid="live-status" data-connection={s.connection} data-phase={s.ingest?.phase}>
      <span className={`live-dot ${tone}`} aria-hidden="true" />
      <button type="button" className="tip-anchor live-word" data-tip={tip}>
        {word}
      </button>
      {catching && s.ingest && <Progress ingest={s.ingest} />}
    </div>
  );
}

function Progress({ ingest }: { ingest: IngestStatus }) {
  const share = ingest.bytesTotal > 0 ? ingest.bytesDone / ingest.bytesTotal : 0;
  return (
    <span className="live-progress" data-testid="ingest-progress">
      <progress max={1} value={share} aria-label="Logs read" />
      <span className="num">
        {ingest.logsDone} of {ingest.logsTotal} logs, {percent(share)}
      </span>
    </span>
  );
}
