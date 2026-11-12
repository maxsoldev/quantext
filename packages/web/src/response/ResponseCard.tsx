/**
 * The Response of Call N: what the model answered, as a chat message. Text with its line breaks and code
 * monospaced, reasoning folded, tool calls as rows that open the tool call. The next Call sends it back as input.
 */
import type { CallResponseDetail, ResponseEntry, SessionKey } from "@quantext/shared";
import { useState } from "react";
import { api } from "../api/client.ts";
import { Link } from "../nav.tsx";
import { callNumber } from "../route.ts";
import { Tokens, Usd } from "../ui/Num.tsx";
import type { Load } from "../ui/useLoad.ts";
import { useLoad } from "../ui/useLoad.ts";
import { segments, stopWords, toolInput } from "./model.ts";

export function ResponseCard({
  sessionKey,
  call,
  resp,
  next,
}: {
  sessionKey: SessionKey;
  call: number;
  resp: Load<CallResponseDetail>;
  /** The next Call of the lane, which sends this answer back; absent for the lane's latest Call. */
  next?: number | undefined;
}) {
  const r = resp.value;
  if (resp.state === "error" && !r) {
    return (
      <p className="error" role="alert">
        The response of call {callNumber(call)} could not be read: {resp.error.message}
      </p>
    );
  }
  if (!r)
    return <section className="card response-card muted">Reading the response of call {callNumber(call)}…</section>;
  const stale = r.call.index !== call;
  return (
    <section
      className={stale ? "card response-card stale" : "card response-card"}
      aria-labelledby="response-title"
      data-testid="response"
    >
      <div className="response-head">
        <h2 id="response-title">
          Response of call <span className="num">{callNumber(r.call.index)}</span>
        </h2>
        <ResponseLede r={r} next={next} sessionKey={sessionKey} />
      </div>
      {r.answered ? (
        <div className="response-message">
          {r.blocks.map((b) => (
            <ResponsePart key={b.hash} b={b} sessionKey={sessionKey} />
          ))}
        </div>
      ) : (
        <p className="response-waiting">
          {next === undefined
            ? "The answer is not in the log yet. It shows here as soon as the harness writes it."
            : "The log holds no answer for this call."}
        </p>
      )}
    </section>
  );
}

function ResponseLede({
  r,
  next,
  sessionKey,
}: {
  r: CallResponseDetail;
  next?: number | undefined;
  sessionKey: SessionKey;
}) {
  const basis = r.call.usage?.basis ?? "exact";
  return (
    <p className="response-lede">
      {r.outputTokens !== undefined && (
        <>
          The model wrote <Tokens n={r.outputTokens} basis={basis} note="From the call's usage: output tokens." />{" "}
          output tokens
          {r.reasoningOutputTokens !== undefined && (
            <>
              {" "}
              (<Tokens n={r.reasoningOutputTokens} basis={basis} note="The reasoning part of the output." /> of
              reasoning)
            </>
          )}
          {r.outputUsd !== undefined && (
            <>
              , <Usd x={r.outputUsd} note="The output part of the call's cost." /> of output
            </>
          )}
          .{" "}
        </>
      )}
      {r.stopReason !== undefined && `${stopWords(r.stopReason)} `}
      {r.answered &&
        (next === undefined ? (
          "The next call will send this answer back as input."
        ) : (
          <>
            <Link to={{ page: "session", key: sessionKey, call: next }}>Call {callNumber(next)}</Link> sends it back as
            input.
          </>
        ))}
    </p>
  );
}

function ResponsePart({ b, sessionKey }: { b: ResponseEntry; sessionKey: SessionKey }) {
  if (b.kind === "reasoning") return <Reasoning b={b} log={sessionKey.log} />;
  if (b.kind === "tool-call") {
    const name = b.toolCall?.name ?? b.source.tool ?? "tool";
    return (
      <div className="response-tool" data-testid="response-tool">
        <span className="response-tool-name">{name}</span>
        <code className="response-tool-input">{toolInput(name, b.preview)}</code>
        {b.toolCall && (
          <Link to={{ page: "session", key: sessionKey, view: "tools", tool: b.toolCall.id }}>Open tool call</Link>
        )}
      </div>
    );
  }
  return <ResponseText b={b} log={sessionKey.log} />;
}

/** Text as the model wrote it: the full text from the block route (the preview has no line breaks). */
function ResponseText({ b, log }: { b: ResponseEntry; log: number }) {
  const full = useLoad((signal) => api.block(log, b.hash, signal), [log, b.hash]);
  const text = full.value?.text ?? b.preview;
  return (
    <div className="response-text" data-testid="response-text">
      {segments(text).map((s, i) =>
        s.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are in a fixed order for one text.
          <pre key={i} className="response-code" data-lang={s.lang}>
            <code>{s.text}</code>
          </pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are in a fixed order for one text.
          <p key={i}>{s.text}</p>
        ),
      )}
    </div>
  );
}

const REASONING_NOTE = {
  omitted: "The log holds only its signature, not its text.",
  redacted: "The provider sent it encrypted; its text is not in the log.",
} as const;

/** Reasoning, folded; its text is read when opened. */
function Reasoning({ b, log }: { b: ResponseEntry; log: number }) {
  const [open, setOpen] = useState(false);
  const shown = b.reasoning === undefined || b.reasoning === "full";
  return (
    <details className="response-reasoning" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Reasoning{shown ? ` (${b.chars.toLocaleString("en-US")} characters)` : `: ${b.reasoning}`}</summary>
      {shown ? (
        open && <ReasoningText b={b} log={log} />
      ) : (
        <p className="muted">{REASONING_NOTE[b.reasoning as "omitted" | "redacted"]}</p>
      )}
    </details>
  );
}

function ReasoningText({ b, log }: { b: ResponseEntry; log: number }) {
  const full = useLoad((signal) => api.block(log, b.hash, signal), [log, b.hash]);
  return <p className="response-reasoning-text">{full.value?.text ?? b.preview}</p>;
}
