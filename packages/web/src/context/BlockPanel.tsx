/**
 * One Block in full, in a side panel: its text, its images, and its content as sent to the provider; where it came
 * from, its tokens, and the Calls it was sent in (links). Escape or the close button closes it.
 */
import type { ContextBlock } from "@quantext/shared";
import { useEffect, useRef } from "react";
import { api } from "../api/client.ts";
import { tokens } from "../format/format.ts";
import { navigate, useRoute } from "../nav.tsx";
import { callNumber } from "../route.ts";
import { Term } from "../teach/Term.tsx";
import { JsonView } from "../ui/JsonView.tsx";
import { Tokens } from "../ui/Num.tsx";
import { useLoad } from "../ui/useLoad.ts";
import { CATEGORY_LABEL } from "./categories.ts";
import { KIND_EXPLAIN, KIND_LABEL, SECTION } from "./kinds.ts";
import { blockSource } from "./model.ts";

export function BlockPanel({
  log,
  block,
  call,
  part,
  output,
  onClose,
}: {
  log: number;
  block: ContextBlock;
  call: number;
  /** The start of a part to scroll to. */
  part?: number | undefined;
  /** A block of the call's output (its answer), not of its input. */
  output?: true | undefined;
  onClose: () => void;
}) {
  const hash = block.hash;
  const detail = useLoad(async (signal) => (hash ? api.block(log, hash, signal) : undefined), [log, hash]);
  const close = useRef<HTMLButtonElement>(null);
  const route = useRoute();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);
  const goTo = (n: number) => {
    if (route.page === "session") navigate({ ...route, call: n }, { replace: true });
  };
  const d = detail.value;
  const source = blockSource(block);
  const parts = (block.parts?.length ?? 0) > 1 ? (block.parts ?? []) : [];
  const text = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (part === undefined || !d) return;
    text.current?.querySelector(`[data-part-start="${part}"]`)?.scrollIntoView({ block: "start" });
  }, [part, d]);
  return (
    <aside className="block-panel" aria-labelledby="block-title" data-testid="block-panel">
      <div className="block-panel-head">
        <div>
          <h3 id="block-title">
            <span className={`kind-dot cat-${block.category}`} aria-hidden="true" />
            {KIND_LABEL[block.kind]} {source && <span className="source">{source}</span>}
          </h3>
          <p className="muted">
            {output
              ? `Output of call ${callNumber(call)}, block ${block.position}`
              : `Position ${block.position}, ${block.section === "framing" ? "framing" : SECTION[block.section].title}`}
          </p>
        </div>
        <button type="button" ref={close} onClick={onClose} aria-label="Close the block">
          Close
        </button>
      </div>
      <dl className="block-facts">
        <div>
          <dt>Tokens</dt>
          <dd>
            {block.tokens !== undefined && block.basis ? <Tokens n={block.tokens} basis={block.basis} /> : "none"}
          </dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{CATEGORY_LABEL[block.category]}</dd>
        </div>
        <div>
          <dt>{output ? "Price" : "Cache"}</dt>
          <dd>
            {output
              ? "Output price; sent again as input from the next call"
              : block.inCachedPrefix
                ? "Read from the cache"
                : "After the cached prefix"}
          </dd>
        </div>
        {block.run && (
          <div>
            <dt>Sent in</dt>
            <dd>
              calls{" "}
              <button type="button" className="link" onClick={() => goTo(block.run?.firstCall ?? call)}>
                {callNumber(block.run.firstCall)}
              </button>{" "}
              to{" "}
              {block.run.lastCall === undefined ? (
                "the latest"
              ) : (
                <button type="button" className="link" onClick={() => goTo(block.run?.lastCall ?? call)}>
                  {callNumber(block.run.lastCall)}
                </button>
              )}
            </dd>
          </div>
        )}
      </dl>
      {KIND_EXPLAIN[block.kind] && <p className="explain">{KIND_EXPLAIN[block.kind]}</p>}
      {block.deferred && (
        <p className="explain">
          A deferred tool: its schema was not in the request's tool list. A tool search loaded it, so from that call on
          it is sent in the messages. <Term id="deferred-tools" />
        </p>
      )}
      <div className="block-content">
        {!hash && <p className="muted">Framing has no content: it is the end of the request after the last block.</p>}
        {hash && detail.state === "error" && (
          <p className="error" role="alert">
            The block could not be read: {detail.error.message}
          </p>
        )}
        {hash && !d && detail.state === "loading" && <p className="muted">Reading the block…</p>}
        {d && (
          <>
            {d.media.map((m) => (
              <figure key={m.hash} className="block-media">
                {m.mediaType.startsWith("image/") ? (
                  <img
                    src={api.mediaUrl(log, d.hash, m.hash)}
                    alt={`Sent to the model: ${m.mediaType}, ${tokens(m.bytes)} bytes`}
                  />
                ) : (
                  <a href={api.mediaUrl(log, d.hash, m.hash)}>Download the {m.mediaType} document</a>
                )}
                <figcaption className="muted">
                  {m.mediaType}, {(m.bytes / 1024).toFixed(0)} KiB
                </figcaption>
              </figure>
            ))}
            <pre className="content block-text" data-testid="block-text" ref={text}>
              {parts.length === 0
                ? d.text
                : parts.map((p) => (
                    <span key={p.start} className="part-text" data-part-start={p.start}>
                      <span className="part-head">
                        {p.label}
                        {p.tokens !== undefined && `, ${tokens(p.tokens)} tokens (estimate)`}
                      </span>
                      {d.text.slice(p.start, p.end)}
                    </span>
                  ))}
            </pre>
            <details className="block-raw">
              <summary>As sent to the provider</summary>
              <div className="content json">
                <JsonView value={d.raw.content} />
              </div>
            </details>
            <p className="muted">
              {d.text.length.toLocaleString("en-US")} characters
              {block.tokens ? `, about ${(d.text.length / Math.max(1, block.tokens)).toFixed(1)} per token` : ""}.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
