/**
 * The query layer on the recorded fixtures. Expected values come from the fixtures themselves: the manifests, and
 * the harness's own `cost-state` totals in the transcripts, never from the store's rows.
 */

import type { CallContext } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { Query } from "../../src/query/index.ts";
import { createQuery, runSql } from "../../src/query/index.ts";
import { mainRows } from "../fixtures.ts";
import { ingested } from "./corpus.ts";

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

async function query(names?: string[]): Promise<Query> {
  const { db } = await ingested(names);
  return createQuery({ db, codec: claudeCodeCodec, now: () => Date.parse("2026-11-13T00:00:00Z") });
}

/** The harness's last cost-state row of a scenario: its own token and cost totals. */
function harnessTotals(scenario: string) {
  const row = mainRows(scenario)
    .filter((r) => r.type === "cost-state")
    .at(-1) as { totalCostUSD: number; modelUsage: Record<string, Record<string, number>> };
  const usage = Object.values(row.modelUsage);
  const sum = (k: string) => usage.reduce((n, u) => n + (u[k] ?? 0), 0);
  return {
    input: sum("inputTokens"),
    cacheRead: sum("cacheReadInputTokens"),
    cacheWrite: sum("cacheCreationInputTokens"),
    output: sum("outputTokens"),
    costUsd: row.totalCostUSD,
  };
}

const key = (q: Query, n: number) => {
  const [found] = q.findSessions(ID(n));
  if (found === undefined) throw new Error(`no session ${ID(n)}`);
  return found;
};

describe("listSessions", () => {
  test("lists each main Session once, newest first, with its subagents nested", async () => {
    const q = await query();
    const page = q.listSessions();
    expect(page.total).toBe(7);
    expect(page.items.map((s) => s.id)).toEqual([4, 7, 6, 5, 3, 2, 1].map(ID));
    const withAgent = page.items.find((s) => s.id === ID(2));
    expect(withAgent?.subagents?.map((s) => s.parentId)).toEqual([ID(2)]);
    expect(withAgent?.subagents?.[0]?.calls).toBe(3);
  });

  test("gives a Session's totals as the harness counted them", async () => {
    const q = await query(["basic-tools"]);
    const [s] = q.listSessions().items;
    const harness = harnessTotals("basic-tools");
    expect(s?.calls).toBe(8);
    expect(s?.tokens).toEqual({
      input: harness.input,
      cacheRead: harness.cacheRead,
      cacheWrite: harness.cacheWrite,
      output: harness.output,
    });
    // The harness prices without the Bedrock regional endpoint's 10 % (the price modifier the Calls carry).
    expect(s?.cost.totalUsd).toBeCloseTo(harness.costUsd * 1.1, 6);
    const c = s?.cost;
    expect((c?.inputUsd ?? 0) + (c?.cacheReadUsd ?? 0) + (c?.cacheWriteUsd ?? 0) + (c?.outputUsd ?? 0)).toBeCloseTo(
      c?.totalUsd ?? 0,
      9,
    );
    expect(s?.cacheHitRate).toBeCloseTo(
      harness.cacheRead / (harness.input + harness.cacheRead + harness.cacheWrite),
      9,
    );
    expect(s).toMatchObject({ requestLog: "present", project: "/fixture-0000000000000000/repo", live: false });
  });

  test("counts a summarising call's derived spend in the totals, but not its input in the max context", async () => {
    const q = await query(["compaction"]);
    const [s] = q.listSessions().items;
    // The summarising call is real spend: the harness's own total includes it.
    expect(s?.cost.totalUsd).toBeCloseTo(harnessTotals("compaction").costUsd * 1.1, 6);
    // Max context is the largest input the log reports for one request (assistant rows' own usage).
    const logged = mainRows("compaction").flatMap((r) => {
      const u = (r.message as { usage?: Record<string, number> } | undefined)?.usage;
      if (r.type !== "assistant" || u === undefined) return [];
      return [(u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)];
    });
    expect(s?.maxContextTokens).toBe(Math.max(...logged));
  });

  test("sorts, pages, filters by project and searches ids", async () => {
    const q = await query();
    const byCalls = q.listSessions({ sort: "calls", order: "desc", limit: 2 });
    expect(byCalls.items.map((s) => s.calls)).toEqual([8, 5]);
    expect(q.listSessions({ sort: "started", order: "asc", limit: 2, offset: 1 }).items.map((s) => s.id)).toEqual([
      ID(2),
      ID(3),
    ]);
    expect(q.listSessions({ project: "repo" }).total).toBe(7);
    expect(q.listSessions({ project: "other" }).total).toBe(0);
    expect(q.listSessions({ search: "0000000005" }).items.map((s) => s.id)).toEqual([ID(5)]);
  });

  test("totals a main Session with its subagents at any depth", async () => {
    // Move Session 1 (its row and Calls) into Session 2's log, as a subagent of Session 2's subagent.
    const { db } = await ingested(["subagent", "basic-tools"], undefined, (w) => {
      const sub = w.prepare("SELECT log, id FROM sessions WHERE parent_id = ?").get(ID(2));
      w.exec("PRAGMA foreign_keys = OFF");
      w.prepare("UPDATE sessions SET log = ?, parent_id = ? WHERE id = ?").run(
        Number(sub?.log),
        String(sub?.id),
        ID(1),
      );
      w.prepare("UPDATE calls SET log = ? WHERE session_id = ?").run(Number(sub?.log), ID(1));
    });
    const q = createQuery({ db, codec: claudeCodeCodec });
    const [main] = q.listSessions().items;
    const sub = main?.subagents?.[0];
    const deep = sub?.subagents?.[0];
    expect([main?.id, deep?.id]).toEqual([ID(2), ID(1)]);
    if (main === undefined || sub === undefined || deep === undefined) return;
    const t = main.totals;
    expect(t.main).toEqual({ sessions: 1, calls: main.calls, tokens: main.tokens, cost: main.cost, unpricedCalls: 0 });
    expect(t.subagents.sessions).toBe(2);
    expect(t.subagents.calls).toBe(sub.calls + deep.calls);
    expect(t.subagents.cost.totalUsd).toBeCloseTo(sub.cost.totalUsd + deep.cost.totalUsd, 9);
    expect(t.subagents.tokens.output).toBe(sub.tokens.output + deep.tokens.output);
    expect(t.all.cost.totalUsd).toBeCloseTo(main.cost.totalUsd + t.subagents.cost.totalUsd, 9);
    expect(t.all.calls).toBe(main.calls + t.subagents.calls);
    expect(sub.totals.subagents.sessions).toBe(1);
    expect(deep.totals.subagents).toMatchObject({ sessions: 0, calls: 0, cost: { totalUsd: 0 } });
    // The Session's detail has the same totals; its direct subagents carry theirs.
    const detail = q.getSession(main);
    expect(detail?.session.totals).toEqual(t);
    expect(detail?.subagents[0]?.totals.subagents.sessions).toBe(1);
  });

  test("sorts by cost with the subagents' cost", async () => {
    const q = await query();
    const items = q.listSessions({ sort: "cost", order: "desc", limit: 100 }).items;
    const all = items.map((s) => s.totals.all.cost.totalUsd);
    expect(all).toEqual([...all].sort((a, b) => b - a));
    const withAgent = items.find((s) => s.id === ID(2));
    expect(withAgent?.totals.subagents.sessions).toBe(1);
    expect(withAgent?.totals.all.cost.totalUsd ?? 0).toBeGreaterThan(withAgent?.cost.totalUsd ?? 0);
  });

  test("marks a Session live when its last event is recent", async () => {
    const { db } = await ingested(["image"]);
    const at = (iso: string) => createQuery({ db, codec: claudeCodeCodec, now: () => Date.parse(iso) });
    expect(at("2026-11-12T00:27:00Z").listSessions().items[0]?.live).toBe(true);
    expect(at("2026-11-12T01:00:00Z").listSessions().items[0]?.live).toBe(false);
  });
});

describe("contextAt", () => {
  test("rebuilds every split Call: its entries add up to its input total, by section and by category", async () => {
    const q = await query();
    let checked = 0;
    for (const s of q.listSessions().items.flatMap((m) => [m, ...(m.subagents ?? [])])) {
      for (const call of q.listCalls(s).items) {
        const ctx = q.contextAt(s, call.index);
        if (ctx === undefined || !ctx.rebuilt || call.usage === undefined) continue;
        const u = call.usage;
        const total = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        expect(sum(ctx.blocks.map((b) => b.tokens ?? 0))).toBe(total);
        expect(sum(Object.values(ctx.sections))).toBe(total);
        expect(sum(Object.values(ctx.categories))).toBe(total);
        expect(ctx.totalTokens).toBe(total);
        expect(ctx.blocks.map((b) => b.position)).toEqual(ctx.blocks.map((_, i) => i));
        expect(ctx.blocks.at(-1)).toMatchObject({ kind: "framing", tokens: call.framingTokens, basis: "framing" });
        const cached = sum(ctx.blocks.filter((b) => b.inCachedPrefix).map((b) => b.tokens ?? 0));
        expect(cached).toBeLessThanOrEqual(u.cacheReadTokens);
        if (call.cost !== undefined) {
          const c = call.cost;
          expect(sum(ctx.blocks.map((b) => b.costUsd ?? 0))).toBeCloseTo(
            c.inputUsd + c.cacheReadUsd + c.cacheWriteUsd,
            9,
          );
        }
        checked++;
      }
    }
    expect(checked).toBe(29);
  });

  test("names each Block's kind, group and source, with a preview of its text", async () => {
    const q = await query(["basic-tools", "image"]);
    const ctx = q.contextAt(key(q, 1), 7);
    const kinds = new Set(ctx?.blocks.map((b) => `${b.kind}>${b.category}`));
    for (const k of [
      "tool-schema>tool-definitions",
      "system>base-instructions",
      "reminder>injected-context",
      "user>user",
      "tool-call>tool-calls",
      "tool-result>tool-outputs",
      "framing>other",
    ]) {
      expect(kinds).toContain(k);
    }
    const big = ctx?.blocks.find((b) => b.kind === "tool-result" && b.source.filePath?.endsWith("src/big.txt"));
    expect(big).toMatchObject({ source: { tool: "Read" }, truncated: true });
    expect(big?.preview.length).toBe(240);
    expect(big?.chars).toBeGreaterThan(10_000);
    const image = q
      .contextAt(key(q, 3), 1)
      ?.blocks.find((b) => b.kind === "tool-result" && b.source.filePath?.endsWith("diagram.png"));
    expect(image).toMatchObject({ kind: "tool-result", category: "tool-outputs", preview: "[image 96x64]" });
  });

  test("counts a system text in the messages as injected context, not as the base instructions", async () => {
    const q = await query(["compaction"]);
    const ctx = q.contextAt(key(q, 5), 4);
    const injected = ctx?.blocks.find((b) => b.position === 20);
    expect(injected).toMatchObject({ kind: "system", section: "messages", category: "injected-context" });
    expect(ctx?.blocks.filter((b) => b.category === "base-instructions").every((b) => b.section === "system")).toBe(
      true,
    );
  });

  test("marks a tool schema sent in the messages (loaded by a tool search) as deferred", async () => {
    const q = await query(["mcp-deferred"]);
    const s = key(q, 6);
    const blocks = q.listCalls(s).items.flatMap((c) => q.contextAt(s, c.index)?.blocks ?? []);
    const deferred = blocks.filter((b) => b.deferred === true);
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((b) => b.kind === "tool-schema" && b.section === "messages")).toBe(true);
    expect(deferred.every((b) => b.category === "tool-definitions")).toBe(true);
    expect(blocks.filter((b) => b.section === "tools").every((b) => b.deferred === undefined)).toBe(true);
  });

  test("lists the parts of a Block that holds several attached texts, with estimates that add up to its tokens", async () => {
    const q = await query(["basic-tools"]);
    const ctx = q.contextAt(key(q, 1), 0);
    const merged = ctx?.blocks.find((b) => (b.parts?.length ?? 0) > 1);
    expect(merged).toMatchObject({ kind: "system", category: "injected-context" });
    expect(merged?.parts?.map((p) => p.label)).toEqual([
      "Environment",
      "Model",
      "Deferred tools",
      "Agent listing",
      "Skill listing",
      "Auto mode",
      "Date",
    ]);
    const parts = merged?.parts ?? [];
    expect(parts.reduce((n, p) => n + (p.tokens ?? 0), 0)).toBe(merged?.tokens);
    expect(parts.every((p) => p.basis === "estimate")).toBe(true);
    const skills = parts.find((p) => p.label === "Skill listing");
    expect(skills).toMatchObject({ source: { attachment: "skill_listing" }, truncated: true });
    expect(skills?.preview).toMatch(/^The following skills are available/);
    expect(skills?.tokens).toBeGreaterThan((merged?.tokens ?? 0) / 2); // 6.3k of 9.6k characters
    expect(ctx?.partTotals).toContainEqual({
      category: "injected-context",
      label: "Skill listing",
      tokens: skills?.tokens,
    });
  });

  test("gives a Block that one attached text is all of one part with the Block's own tokens and basis", async () => {
    const q = await query(["basic-tools"]);
    const ctx = q.contextAt(key(q, 1), 0);
    const block = ctx?.blocks.find((b) => b.source.attachment === "session_context");
    expect(block?.parts).toMatchObject([{ label: "Session context", tokens: block?.tokens, basis: block?.basis }]);
  });

  test("is undefined for a Call or Session that does not exist", async () => {
    const q = await query(["image"]);
    expect(q.contextAt(key(q, 3), 99)).toBeUndefined();
    expect(q.contextAt({ log: 99, id: ID(3) }, 0)).toBeUndefined();
  });
});

describe("turns", () => {
  /** The context of a scenario's main Session at its last Call. */
  async function lastContext(name: string) {
    const q = await query([name]);
    const [s] = q.listSessions().items;
    if (s === undefined) throw new Error(`no session in ${name}`);
    const last = q.listCalls(s).items.at(-1);
    const ctx = last && q.contextAt(s, last.index);
    if (ctx === undefined) throw new Error(`no context in ${name}`);
    return ctx;
  }
  const prompts = (ctx: CallContext) => ctx.turns.map((t) => t.prompt?.preview.slice(0, 20));

  test("cover the messages in order: each message Block is in one turn, and the turns add up", async () => {
    const q = await query();
    for (const s of q.listSessions().items.flatMap((m) => [m, ...(m.subagents ?? [])])) {
      for (const call of q.listCalls(s).items) {
        const ctx = q.contextAt(s, call.index);
        if (ctx === undefined || !ctx.rebuilt) continue;
        const messages = ctx.blocks.filter((b) => b.section === "messages");
        expect(ctx.turns.map((t) => t.turn)).toEqual(ctx.turns.map((_, i) => i + 1));
        expect(ctx.turns[0]?.start).toBe(messages[0]?.position);
        expect(ctx.turns.reduce((n, t) => n + t.blocks, 0)).toBe(messages.length);
        expect(ctx.turns.reduce((n, t) => n + t.tokens, 0)).toBe(ctx.sections.messages);
        for (const t of ctx.turns) {
          const own = messages.filter((b) => b.turn === t.turn);
          expect(own.map((b) => b.position)).toEqual(own.map((_, i) => t.start + i));
          expect(t.cachedTokens).toBe(own.reduce((n, b) => n + (b.inCachedPrefix ? (b.tokens ?? 0) : 0), 0));
        }
        expect(ctx.blocks.filter((b) => b.section !== "messages" && b.turn !== undefined)).toEqual([]);
      }
    }
  });

  test("a turn starts at each prompt; what the harness sends before the first prompt joins the first turn", async () => {
    const ctx = await lastContext("resume");
    expect(prompts(ctx)).toEqual(["Summarise @notes.txt", "How many list items ", "Use the Skill tool t"]);
    const first = ctx.blocks.find((b) => b.section === "messages");
    expect(first?.kind).toBe("reminder");
    expect(first?.turn).toBe(1);
    const second = ctx.turns[1];
    expect(ctx.blocks[second?.start ?? -1]?.preview).toMatch(/^How many list items/);
  });

  test("a compaction summary is not a prompt: with the answer kept after it, it is a turn with no prompt", async () => {
    const ctx = await lastContext("compaction");
    expect(prompts(ctx)).toEqual([undefined, "Which two files did "]);
    expect(ctx.blocks.find((b) => b.kind === "summary")?.turn).toBe(1);
  });

  test("a note the harness adds after a tool result does not start a turn", async () => {
    const ctx = await lastContext("mcp-deferred");
    expect(prompts(ctx)).toEqual(["Use the lookup_word "]);
  });

  test("a Session resumed on another model keeps its earlier prompts as turns", async () => {
    const q = await query();
    const s = key(q, 7);
    const last = q.listCalls(s).items.at(-1);
    const ctx = last && q.contextAt(s, last.index);
    expect(ctx && prompts(ctx)).toEqual(["Without tools: a tra", "And if the trip took", "And if it left 10 mi"]);
  });
});

describe("responseAt", () => {
  test("gives the last call's answer: its text, why it stopped, its output tokens and their cost", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const last = q.listCalls(s).items.at(-1);
    const answer = mainRows("basic-tools")
      .filter((r) => r.type === "assistant")
      .at(-1) as { message: { content: { text: string }[]; stop_reason: string; usage: { output_tokens: number } } };
    const r = q.responseAt(s, last?.index ?? -1);
    expect(r).toMatchObject({
      answered: true,
      stopReason: answer.message.stop_reason,
      outputTokens: answer.message.usage.output_tokens,
      outputUsd: last?.cost?.outputUsd,
    });
    const text = r?.blocks.find((b) => b.kind === "assistant");
    expect(text?.category).toBe("assistant");
    expect(q.getBlock(text?.hash ?? "", s.log)?.text).toBe(answer.message.content[0]?.text);
  });

  test("names a tool call of the answer by its tool use id and tool, and marks omitted reasoning", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const r = q
      .listCalls(s)
      .items.map((c) => q.responseAt(s, c.index))
      .find((x) => x?.blocks[0]?.kind === "reasoning");
    expect(r?.blocks.map((b) => [b.kind, b.reasoning ?? b.toolCall?.name ?? ""])).toEqual([
      ["reasoning", "omitted"],
      ["assistant", ""],
      ["tool-call", "Read"],
    ]);
    expect(r?.blocks[2]?.toolCall?.id).toBe(r?.call.toolCalls[0]?.id);
  });

  test("is undefined for a Call or Session that does not exist", async () => {
    const q = await query(["image"]);
    expect(q.responseAt(key(q, 3), 99)).toBeUndefined();
  });

  test("splits the output tokens and their cost over the answer's Blocks", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    for (const c of q.listCalls(s).items) {
      const r = q.responseAt(s, c.index);
      if (!r?.answered || r.outputTokens === undefined || r.outputUsd === undefined) continue;
      const blocks = r.blocks;
      const sum = (f: (b: (typeof blocks)[number]) => number) => blocks.reduce((n, b) => n + f(b), 0);
      expect(sum((b) => b.tokens ?? Number.NaN)).toBe(r.outputTokens);
      expect(sum((b) => b.costUsd ?? Number.NaN)).toBeCloseTo(r.outputUsd, 9);
      const basis = r.blocks.length === 1 ? r.call.usage?.basis : "estimate";
      for (const b of r.blocks) expect(b.basis).toBe(basis);
    }
  });

  test("gives omitted reasoning a share of the output, though the log holds no text of it", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const r = q
      .listCalls(s)
      .items.map((c) => q.responseAt(s, c.index))
      .find((x) => x?.blocks[0]?.reasoning === "omitted");
    expect(r?.blocks[0]?.tokens).toBeGreaterThan(0);
  });
});

describe("fromResponseOf", () => {
  test("marks each Block of a context that an earlier Call answered with that Call", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const calls = q.listCalls(s).items;
    const lastIdx = calls.at(-1)?.index ?? -1;
    const ctx = q.contextAt(s, lastIdx);
    const answered = (ctx?.blocks ?? []).filter((b) => b.kind === "assistant" || b.kind === "tool-call");
    expect(answered.length).toBeGreaterThan(1);
    for (const b of answered) {
      const from = b.fromResponseOf;
      expect(from).toBeDefined();
      expect(from).toBeLessThan(b.run?.firstCall ?? 0);
      expect(q.responseAt(s, from ?? -1)?.blocks.map((x) => x.hash)).toContain(b.hash);
    }
    expect(ctx?.blocks.filter((b) => b.kind === "user" || b.kind === "tool-schema").some((b) => b.fromResponseOf)).toBe(
      false,
    );
  });

  test("the response of a Call is in the next Call of its lane, marked with it", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const [first, second] = q.listCalls(s).items.filter((c) => c.lane === q.listCalls(s).items[0]?.lane);
    const hashes = q.responseAt(s, first?.index ?? -1)?.blocks.map((b) => b.hash) ?? [];
    const ctx = q.contextAt(s, second?.index ?? -1);
    const marked = ctx?.blocks.filter((b) => b.fromResponseOf === first?.index).map((b) => b.hash);
    expect(marked).toEqual(hashes);
  });
});

describe("contextDiff", () => {
  test("the lane's first Call adds every Block; a later one adds the new turn and keeps the cached prefix", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const first = q.contextDiff(s, 0);
    expect(first?.previous).toBeUndefined();
    expect(first?.added.length).toBe(q.contextAt(s, 0)?.blocks.filter((b) => b.hash !== undefined).length);
    const next = q.contextDiff(s, 1);
    expect(next?.previous).toBe(0);
    expect(next?.removed).toEqual([]);
    expect(next?.added.map((b) => b.kind)).toContain("tool-result");
    expect(next?.firstChange).toBe(Math.min(...(next?.added ?? []).map((b) => b.position)));
  });

  test("shows where the cache broke: the first change, the cache read lost, the Blocks after it", async () => {
    const q = await query(["compaction"]);
    const s = key(q, 5);
    const calls = q.listCalls(s).items.filter((c) => c.lane === q.listCalls(s).items[0]?.lane);
    const breaks = calls.filter(
      (c, i) => (c.usage?.cacheReadTokens ?? 0) < (calls[i - 1]?.usage?.cacheReadTokens ?? 0),
    );
    // After the compaction: the summary replaces the messages.
    expect(breaks).toHaveLength(1);
    const call = breaks[0];
    const diff = q.contextDiff(s, call?.index ?? -1);
    const prev = call === undefined ? undefined : calls[calls.indexOf(call) - 1];
    expect(diff?.previous).toBe(prev?.index);
    expect(diff?.cacheReadDrop).toBe((prev?.usage?.cacheReadTokens ?? 0) - (call?.usage?.cacheReadTokens ?? 0));
    // The provider read the unchanged prefix from its cache: up to the first change.
    expect(diff?.firstChange).toBe(call?.cacheBoundary?.position);
    expect(diff?.added.find((b) => b.position === diff.firstChange)?.kind).toBe("summary");
    expect(diff?.removed.map((b) => b.kind)).toContain("tool-result");
    // Content in both, at another position, is moved: neither added nor removed.
    const hashes = (xs: { hash?: string }[] | undefined) => new Set((xs ?? []).map((b) => b.hash));
    for (const m of diff?.moved ?? []) {
      expect(m.from).not.toBe(m.position);
      expect(hashes(diff?.added).has(m.hash)).toBe(false);
      expect(hashes(diff?.removed).has(m.hash)).toBe(false);
    }
    expect(diff?.moved.length).toBeGreaterThan(0);
  });
});

describe("a Session's detail", () => {
  test("estimates the unlogged progress summaries of its subagents, apart from the exact totals", async () => {
    // Stretch the subagent's run to 95 s, with its three requests sent at 0, 40 and 70 s.
    const { db } = await ingested(["subagent"], undefined, (w) => {
      const sub = String(w.prepare("SELECT id FROM sessions WHERE parent_id = ?").get(ID(2))?.id);
      const at = (s: number) => new Date(Date.parse("2026-11-12T01:00:00Z") + s * 1000).toISOString();
      w.prepare("UPDATE sessions SET started = ?, ended = ? WHERE id = ?").run(at(0), at(95), sub);
      for (const [idx, s] of [0, 40, 70].entries())
        w.prepare("UPDATE calls SET ts = ? WHERE session_id = ? AND idx = ?").run(at(s), sub, idx);
    });
    const q = createQuery({ db, codec: claudeCodeCodec });
    const detail = q.getSession(key(q, 2));
    const prompts = q
      .listCalls({ log: key(q, 2).log, id: String(detail?.subagents[0]?.id) })
      .items.map(
        (c) => (c.usage?.inputTokens ?? 0) + (c.usage?.cacheReadTokens ?? 0) + (c.usage?.cacheWriteTokens ?? 0),
      );
    const read = prompts.reduce((a, b) => a + b, 0);
    expect(detail?.unlogged).toMatchObject({ calls: 3, cacheReadTokens: read, unpricedCalls: 0, subagents: 1 });
    // Opus 5.5 on a Bedrock regional endpoint (+10%), like the subagent's own Calls.
    expect(detail?.unlogged.costUsd).toBeCloseTo(1.1 * (read * 0.2e-6 + 3 * (400 * 4e-6 + 40 * 20e-6)), 9);
    expect(detail?.session.totals).toEqual(q.listSessions().items[0]?.totals);
    const sub = detail?.subagents[0];
    if (sub !== undefined) expect(q.getSession(sub)?.unlogged.calls).toBe(0);
  });

  test("has its lanes, subagents and tool calls", async () => {
    const q = await query(["subagent", "basic-tools"]);
    const detail = q.getSession(key(q, 2));
    expect(detail?.subagents.map((s) => s.agentName ?? s.id)).toHaveLength(1);
    expect(detail?.lanes.map((l) => l.calls)).toEqual([2]);
    const tools = q.toolCalls(key(q, 1)).items;
    // The steps of the scenario, and a Read of the file before its Edit.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "Bash",
      "Bash",
      "Bash",
      "Edit",
      "Read",
      "Read",
      "Read",
      "Read",
      "Read",
    ]);
    expect(tools.filter((t) => t.isError).map((t) => t.input)).toEqual([
      { file_path: "/fixture-0000000000000000/repo/missing.txt" },
    ]);
    expect(tools.every((t) => t.resultTokens !== undefined && t.callIndex !== undefined)).toBe(true);
    expect(tools.every((t) => t.resultBasis !== undefined)).toBe(true);
    const parallel = q
      .listCalls(key(q, 1))
      .items.filter((c) => c.toolCalls.filter((t) => t.name === "Read").length === 2);
    expect(parallel).toHaveLength(1);
  });

  test("prices each tool call's own Block as input to the Calls after it, next to its output", async () => {
    const q = await query(["basic-tools"]);
    const outputs = q.toolOutputs(key(q, 1), { limit: 100 }).items;
    expect(outputs).toHaveLength(9);
    for (const o of outputs) {
      // The model wrote the call in Call n; Call n + 1 sends it back with the result, so both stay as long.
      expect(o.toolCall?.calls).toBeGreaterThan(0);
      expect(o.toolCall?.calls).toBe(o.calls);
      expect(o.toolCall?.costUsd.total).toBeGreaterThan(0);
      expect(["exact", "derived", "anchored", "estimate"]).toContain(o.toolCall?.basis);
      const parts = o.toolCall?.costUsd;
      expect((parts?.cacheRead ?? 0) + (parts?.cacheWrite ?? 0) + (parts?.input ?? 0)).toBeCloseTo(
        parts?.total ?? 0,
        12,
      );
    }
  });

  test("has its compaction with the sizes the harness logged, and what was removed and kept", async () => {
    const q = await query(["compaction"]);
    const [c] = q.compactions(key(q, 5)).items;
    expect(c).toMatchObject({ trigger: "manual", beforeTokens: 16778, afterTokens: 2865 });
    expect(c?.afterCallIndex).toBeGreaterThan(c?.beforeCallIndex ?? 99);
    const before = q.contextAt(key(q, 5), c?.beforeCallIndex ?? -1);
    const blockTokens = (before?.blocks ?? [])
      .filter((b) => b.hash !== undefined)
      .reduce((n, b) => n + (b.tokens ?? 0), 0);
    expect((c?.removed?.tokens ?? 0) + (c?.kept?.tokens ?? 0)).toBe(blockTokens);
    expect(c?.kept?.categories["tool-definitions"]).toBeGreaterThan(0);
    expect(c?.removed?.categories["tool-outputs"]).toBeGreaterThan(0);
    expect(c?.summaryTokens).toBeGreaterThan(0);
    // The Session's detail has the compaction without the contexts (they cost two reads each).
    const { removed: _r, kept: _k, summaryTokens: _s, ...plain } = c ?? { removed: 0, kept: 0, summaryTokens: 0 };
    expect(q.getSession(key(q, 5))?.compactions).toEqual([plain]);
  });

  test("gives a Block's whole text and content, and an image's media", async () => {
    const q = await query(["image"]);
    const s = key(q, 3);
    const image = q
      .contextAt(s, 1)
      ?.blocks.find((b) => b.kind === "tool-result" && b.source.filePath?.endsWith("diagram.png"));
    const block = q.getBlock(image?.hash ?? "", s.log);
    expect(block?.text).toBe("[image 96x64]");
    expect(block?.media).toHaveLength(1);
    expect(block?.media[0]?.mediaType).toBe("image/png");
    const bytes = q.getMedia(block?.hash ?? "", s.log, block?.media[0]?.hash ?? "")?.bytes;
    expect(q.getMedia("not-the-block", s.log, block?.media[0]?.hash ?? "")).toBeUndefined();
    expect([...(bytes ?? []).slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect(q.getBlock(image?.hash ?? "", 99)).toBeUndefined();
  });
});

describe("the report", () => {
  test("counts the Calls' issues and the record kinds ingest ignored, with nothing pending", async () => {
    const q = await query();
    const report = q.ingestReport();
    expect(report.unknownRecords).toEqual([]);
    expect(report.ignoredRecords.map((r) => r.kind)).toContain("queue-operation");
    expect(report.issues["unresolved-request"]).toBe(1);
    expect(report.pendingBytes).toBe(0);
    expect(report.requestLogs).toEqual([{ requestLog: "present", sessions: 8 }]);
  });
});

describe("for the live viewer", () => {
  test("gives change events as the API sends them: Session keys and projects, not the harness's folders", async () => {
    const { db } = await ingested(["basic-tools"]);
    const q = createQuery({ db, codec: claudeCodeCodec });
    const s = key(q, 1);
    const logDir = String(db.prepare("SELECT path FROM logs").get()?.path).replace(/[\\/][^\\/]+$/, "");
    const calls = {
      kind: "calls",
      logId: s.log,
      cursor: 5,
      sessionId: s.id,
      added: ["a"],
      addedIndexes: [3],
      updated: ["b"],
    };
    expect(q.publicEvent({ ...calls, kind: "calls" })).toEqual({
      kind: "calls",
      cursor: 5,
      session: s,
      added: [{ id: "a", index: 3 }],
      updated: ["b"],
    });
    expect(q.publicEvent({ kind: "log-removed", logId: s.log, cursor: 6 })).toEqual({
      kind: "log-removed",
      cursor: 6,
      logId: s.log,
    });
    expect(q.publicEvent({ kind: "memory", cursor: 7, projectDirs: [logDir] })).toEqual({
      kind: "memory",
      cursor: 7,
      projects: ["/fixture-0000000000000000/repo"],
    });
    expect(q.publicEvent({ kind: "memory", cursor: 8, projectDirs: ["/no/such/folder"] })).toBeNull();
  });

  test("the timeline has every Call with its usage, cost and the context-bar totals of its context", async () => {
    const q = await query(["compaction", "basic-tools"]);
    for (const n of [1, 5]) {
      const s = key(q, n);
      const timeline = q.callTimeline(s);
      expect(timeline.apiVersion).toBe(1);
      const calls = q.listCalls(s).items;
      expect(timeline.items.map((t) => t.index)).toEqual(calls.map((c) => c.index));
      for (const t of timeline.items) {
        const ctx = q.contextAt(s, t.index);
        expect(t).toMatchObject({
          lane: ctx?.lane,
          rebuilt: ctx?.rebuilt,
          categories: ctx?.categories,
          sections: ctx?.sections,
        });
        const call = calls.find((c) => c.index === t.index);
        expect(t.usage).toEqual(call?.usage);
        expect(t.issues).toEqual(call?.issues.map((i) => i.kind));
      }
    }
    const marks = q.callTimeline(key(q, 5)).items.filter((t) => t.compaction !== undefined);
    expect(marks.map((t) => t.compaction)).toEqual(["summary", "after"]);
  });

  test("lists Calls page by page after an index", async () => {
    const q = await query(["basic-tools"]);
    const s = key(q, 1);
    const first = q.listCalls(s, { limit: 3 });
    expect(first).toMatchObject({ total: 8, offset: 0 });
    expect(first.items.map((c) => c.index)).toEqual([0, 1, 2]);
    const next = q.listCalls(s, { afterIndex: 2, limit: 3 });
    expect(next).toMatchObject({ total: 8, offset: 3 });
    expect(next.items.map((c) => c.index)).toEqual([3, 4, 5]);
  });

  test("lists only the Sessions changed after a cursor, and gives the cursor to go on from", async () => {
    const q = await query(["basic-tools", "image"]);
    const all = q.listSessions();
    expect(all.cursor).toBeGreaterThan(0);
    expect(q.listSessions({ changedSince: all.cursor ?? 0 }).items).toEqual([]);
    const image = q.listSessions({ changedSince: (all.cursor ?? 0) - 1 }).items.map((s) => s.id);
    expect(image).toEqual([ID(3)]); // ingested last
  });

  test("lists the projects with their main Sessions, latest first", async () => {
    const q = await query(["basic-tools", "image", "subagent"]);
    const sessions = q.listSessions().items;
    const projects = q.listProjects();
    expect(projects.apiVersion).toBe(1);
    expect(projects.items).toEqual([
      { project: "/fixture-0000000000000000/repo", sessions: sessions.length, ended: sessions[0]?.ended },
    ]);
  });

  test("gives the change cursor alone, as a page gives it", async () => {
    const q = await query(["basic-tools", "image"]);
    expect(q.changeCursor()).toBe(q.listSessions().cursor);
  });

  test("tells whether a Session exists, by its key", async () => {
    const q = await query(["basic-tools"]);
    const k = key(q, 1);
    expect(q.hasSession(k)).toBe(true);
    expect(q.hasSession({ ...k, log: k.log + 1 })).toBe(false);
    expect(q.hasSession({ ...k, id: "nope" })).toBe(false);
  });

  test("keeps the provider's own data out of the stable types, behind raw", async () => {
    const q = await query(["effort"]);
    const s = key(q, 7);
    const calls = q.listCalls(s).items;
    expect(calls.every((c) => !("provider" in c.params))).toBe(true);
    const detail = q.getCall(s, 0);
    expect(detail?.call.index).toBe(0);
    expect(detail?.raw.params.provider).toBeDefined();
    const block = q.contextAt(s, 0)?.blocks[0];
    const full = q.getBlock(block?.hash ?? "", s.log);
    expect(full && "content" in full).toBe(false);
    expect(full?.raw.content).toBeDefined();
  });
});

describe("cache breaks", () => {
  test("after a compaction, and when the model changes (compared with the previous Call in time)", async () => {
    const q = await query(["compaction", "effort"]);
    expect(q.cacheBreaks(key(q, 5)).items.map((b) => [b.index, b.previous.index, b.reason])).toEqual([
      [4, 2, "compaction"],
    ]);
    const effort = key(q, 7);
    const calls = q.listCalls(effort).items;
    const switched = calls.find((c, i) => i > 0 && c.model !== calls[i - 1]?.model);
    const breaks = q.cacheBreaks(effort).items;
    expect(breaks.map((b) => b.reason)).toContain("model-switch");
    const b = breaks.find((x) => x.reason === "model-switch");
    expect(b).toMatchObject({ index: switched?.index, previous: { index: (switched?.index ?? 0) - 1 } });
    const diff = q.contextDiff(effort, switched?.index ?? -1);
    expect(diff).toMatchObject({ previous: (switched?.index ?? 0) - 1, modelSwitch: true });
    // Nothing was read from the cache: what the new model got of the old request is written again.
    expect(diff?.uncached.length).toBeGreaterThan(0);
    expect(diff?.uncached.every((x) => !x.inCachedPrefix)).toBe(true);
  });

  test("names a long pause (the cache's time to live) and a changed prefix", async () => {
    const at = (s: number) => new Date(Date.parse("2026-11-12T00:26:10Z") + s * 1000).toISOString();
    const { db } = await ingested(["basic-tools"], undefined, (w) => {
      const set = w.prepare("UPDATE calls SET cache_read_tokens = ?, ts = ? WHERE idx = ?");
      set.run(100, at(400), 3); // 400 s after call 2: the 5-minute cache ran out
      set.run(50, at(410), 4); // 10 s later: something early in the request changed
      w.prepare("UPDATE calls SET ts = ? WHERE idx = 2").run(at(0));
      w.prepare("UPDATE calls SET ts = ? WHERE idx IN (5, 6, 7)").run(at(420));
    });
    const q = createQuery({ db, codec: claudeCodeCodec });
    const breaks = q.cacheBreaks(key(q, 1)).items;
    expect(breaks.map((b) => [b.index, b.reason, b.gapSeconds])).toEqual([
      [3, "ttl", 400],
      [4, "prefix-change", 10],
    ]);
    const view = runSql(db, "SELECT idx, reason FROM v_cache_breaks ORDER BY idx").rows;
    expect(view).toEqual([
      { idx: 3, reason: "ttl" },
      { idx: 4, reason: "prefix-change" },
    ]);
  });
});
