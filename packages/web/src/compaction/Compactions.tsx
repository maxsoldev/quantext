/**
 * A Session's compactions, each before and after: what was removed and what was kept (by category), the summary
 * that replaced the rest, and the call that wrote it, whose usage is derived because the log does not hold it.
 */
import type { CompactionDetail, SessionKey, TimelineCall } from "@quantext/shared";
import { api } from "../api/client.ts";
import { CATEGORIES, CATEGORY_LABEL } from "../context/categories.ts";
import { count, percent, tokens, when } from "../format/format.ts";
import { Link } from "../nav.tsx";
import { Term } from "../teach/Term.tsx";
import { Tokens } from "../ui/Num.tsx";
import { useLoad } from "../ui/useLoad.ts";
import type { CompactionPart, CompactionSegment, CompactionView } from "./model.ts";
import { compactionView } from "./model.ts";

const PART_LABEL: Record<CompactionPart, string> = {
  kept: "Kept",
  removed: "Removed",
  summary: "Summary",
  added: "Added by the next call",
};

export function Compactions({
  sessionKey,
  timeline,
  version,
}: {
  sessionKey: SessionKey;
  timeline: readonly TimelineCall[];
  version: number;
}) {
  const data = useLoad((signal) => api.compactions(sessionKey, signal), [sessionKey.log, sessionKey.id, version]);
  if (data.state === "error" && !data.value) {
    return (
      <p className="error" role="alert">
        The compactions could not be read: {data.error.message}
      </p>
    );
  }
  if (!data.value) return <section className="card muted">Reading the compactions…</section>;
  const compactions = data.value.items;
  if (compactions.length === 0) {
    return (
      <section className="card empty" data-testid="compactions">
        <h2>No compaction in this session</h2>
        <p>
          When the context gets close to full, or when you ask for it (<code>/compact</code>), the harness replaces the
          conversation with a short summary and goes on from there. This session never needed it.
        </p>
      </section>
    );
  }
  const byIndex = new Map(timeline.map((c) => [c.index, c]));
  return (
    <div className="compactions" data-testid="compactions">
      {compactions.map((c, i) => (
        <CompactionCard key={c.id} n={i + 1} c={c} byIndex={byIndex} sessionKey={sessionKey} />
      ))}
    </div>
  );
}

function inputOf(c: TimelineCall | undefined): number | undefined {
  const u = c?.usage;
  return u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : undefined;
}

function CompactionCard({
  n,
  c,
  byIndex,
  sessionKey,
}: {
  n: number;
  c: CompactionDetail;
  byIndex: Map<number, TimelineCall>;
  sessionKey: SessionKey;
}) {
  const after = c.afterCallIndex === undefined ? undefined : byIndex.get(c.afterCallIndex);
  const view = compactionView(c, inputOf(after));
  const summaryCall = c.summaryCallIndex === undefined ? undefined : byIndex.get(c.summaryCallIndex);
  const link = (call: number) => ({ page: "session" as const, key: sessionKey, call });
  return (
    <section className="card compaction-card" aria-labelledby={`compaction-${n}`} data-testid="compaction">
      <div className="diff-head">
        <h2 id={`compaction-${n}`}>
          <Term id="compaction">Compaction {n}</Term>
        </h2>
        <p className="muted">
          {when(c.ts)},{" "}
          {c.trigger === "manual" ? "asked for (/compact)" : c.trigger === "auto" ? "automatic" : c.trigger}
        </p>
      </div>
      {view ? (
        <>
          <p className="diff-lede">
            The harness removed{" "}
            <Tokens n={view.figures.removed} note="The blocks of the call before that the call after does not hold." />{" "}
            tokens and kept <Tokens n={view.figures.kept} note="The blocks both calls hold, by content." />. A summary
            of <Tokens n={view.figures.summary} note="The summary block's tokens in the call after." /> tokens took the
            place of the conversation, so the next call started at{" "}
            <Tokens n={view.figures.after} note="The input total of the call after, from its usage." /> tokens,{" "}
            {view.figures.freed > 0 ? `${percent(view.figures.freed)} less than before` : "no less than before"}.
          </p>
          <Bars view={view} before={c.beforeCallIndex} after={c.afterCallIndex} />
          <CategoryTable c={c} />
        </>
      ) : (
        <p className="muted">
          The log does not hold the requests around this compaction, so what was removed and kept cannot be shown.
          {c.beforeTokens !== undefined && ` The harness reports ${tokens(c.beforeTokens)} tokens before it`}
          {c.afterTokens !== undefined && ` and ${tokens(c.afterTokens)} after it`}
          {c.beforeTokens !== undefined && "."}
        </p>
      )}
      {c.summaryCallIndex !== undefined && (
        <div className="summary-call">
          <h3>The call that wrote the summary</h3>
          <p>
            Call {c.summaryCallIndex} sent the whole context to the model with the request to summarise it.
            {summaryCall?.usage && (
              <>
                {" "}
                It read{" "}
                <Tokens
                  n={inputOf(summaryCall) ?? 0}
                  basis={summaryCall.usage.basis}
                  note="The summarising call's input."
                />{" "}
                tokens and wrote{" "}
                <Tokens
                  n={summaryCall.usage.outputTokens}
                  basis={summaryCall.usage.basis}
                  note="The summary, as the call's output."
                />{" "}
                tokens.
              </>
            )}{" "}
            The harness does not log this call. Its numbers are <b>derived</b> (marked Δ): computed from the exact
            running totals of the calls around it, so they are exact sums, not estimates.
          </p>
        </div>
      )}
      <p className="compaction-links">
        {c.beforeCallIndex !== undefined && (
          <Link to={link(c.beforeCallIndex)}>Context before (call {c.beforeCallIndex})</Link>
        )}
        {c.afterCallIndex !== undefined && (
          <Link to={link(c.afterCallIndex)}>Context after and what changed (call {c.afterCallIndex})</Link>
        )}
      </p>
    </section>
  );
}

function Bars({
  view,
  before,
  after,
}: {
  view: CompactionView;
  before?: number | undefined;
  after?: number | undefined;
}) {
  return (
    <div className="diff-strips compaction-bars">
      <Bar
        label={before === undefined ? "Before" : `Call ${before}`}
        segments={view.before}
        total={view.figures.before}
        testId="before-bar"
      />
      <Bar
        label={after === undefined ? "After" : `Call ${after}`}
        segments={view.after}
        total={view.figures.after}
        testId="after-bar"
      />
    </div>
  );
}

/** The bar of one context: segments by category, with a bracket over each part (kept, removed, …). */
function Bar({
  label,
  segments,
  total,
  testId,
}: {
  label: string;
  segments: CompactionSegment[];
  total: number;
  testId: string;
}) {
  const groups: { part: CompactionPart; left: number; width: number; tokens: number }[] = [];
  for (const s of segments) {
    const g = groups.at(-1);
    if (g && g.part === s.part) {
      g.width += s.width;
      g.tokens += s.tokens;
    } else groups.push({ part: s.part, left: s.left, width: s.width, tokens: s.tokens });
  }
  return (
    <div className="diff-row">
      <span className="diff-label num">
        {label}
        <span className="muted"> {tokens(total)}</span>
      </span>
      <div className="compaction-bar" data-testid={testId}>
        <div className="part-brackets" aria-hidden="true">
          {groups.map((g) => (
            <span
              key={g.part}
              className={`part-bracket part-${g.part}`}
              style={{ left: `${g.left}%`, width: `${g.width}%` }}
            >
              {g.width >= 16 && (
                <span>
                  {PART_LABEL[g.part]} {tokens(g.tokens)}
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="diff-strip">
          {segments.map((s) => (
            <span
              key={`${s.part}-${s.category}`}
              className={`diff-seg cat-${s.category}${s.part === "removed" ? " part-removed" : ""}${s.part === "added" ? " part-added" : ""}`}
              style={{ left: `${s.left}%`, width: `${s.width}%` }}
              data-part={s.part}
              data-tip={`${PART_LABEL[s.part]}: ${s.part === "summary" ? "the summary" : s.part === "added" ? "the new prompt and context of the next call" : CATEGORY_LABEL[s.category]}\n${tokens(s.tokens)} tokens`}
            />
          ))}
        </div>
        {groups.some((g) => g.width < 16) && (
          <p className="part-caption">
            {groups
              .filter((g) => g.width < 16)
              .map((g) => `${PART_LABEL[g.part]} ${tokens(g.tokens)}`)
              .join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

function CategoryTable({ c }: { c: CompactionDetail }) {
  if (!c.removed || !c.kept) return null;
  const rows = CATEGORIES.map((k) => ({
    ...k,
    removed: c.removed?.categories[k.key] ?? 0,
    kept: c.kept?.categories[k.key] ?? 0,
  })).filter((r) => r.removed + r.kept > 0);
  return (
    <table className="cat-table compaction-table" aria-label="Removed and kept, by category">
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="right">
            Before
          </th>
          <th scope="col" className="right">
            Removed
          </th>
          <th scope="col" className="right">
            Kept
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">
              <button type="button" className="tip-anchor legend-item" data-tip={r.explain}>
                <span className={`swatch cat-${r.key}`} aria-hidden="true" />
                {r.label}
              </button>
            </th>
            <td className="right num">{tokens(r.removed + r.kept)}</td>
            <td className="right num">{r.removed > 0 ? tokens(r.removed) : ""}</td>
            <td className="right num">{r.kept > 0 ? tokens(r.kept) : ""}</td>
          </tr>
        ))}
        <tr className="total-row">
          <th scope="row">{count(c.removed.blocks + c.kept.blocks, "block")}</th>
          <td className="right num">{tokens(c.removed.tokens + c.kept.tokens)}</td>
          <td className="right num">{tokens(c.removed.tokens)}</td>
          <td className="right num">{tokens(c.kept.tokens)}</td>
        </tr>
      </tbody>
    </table>
  );
}
