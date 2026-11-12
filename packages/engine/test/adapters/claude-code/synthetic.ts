/**
 * A synthetic Claude Code transcript of a long tool loop, for performance tests: every call keeps all messages of
 * the call before and adds the assistant's tool use and its tool result. Hashes follow Claude Code's rules.
 */
import { sha256Sorted } from "../../../src/adapters/claude-code/hash.ts";
import type { Json } from "../../../src/adapters/claude-code/json.ts";

/**
 * `sideEvery`: after every so many calls, a side call in another lane (another query source) that branches from
 * the main loop's latest call and adds one question.
 */
export function syntheticSession(calls: number, sideEvery = 0): string {
  const session = "00000000-0000-4000-8000-00000000beef";
  const rows: object[] = [];
  const wire = (role: string, content: Json[]) => sha256Sorted({ role, content });
  const shape = {
    system: [{ type: "text", text: "You are a test agent. ".repeat(200) }],
    tools: [{ name: "Read", description: "Read a file. ".repeat(50), input_schema: { type: "object" } }],
  };
  const shapeHash = sha256Sorted(shape as unknown as Json);
  rows.push({ type: "api-request-shape", sessionId: session, shapeHash, shape });
  const prompt: Json[] = [{ type: "text", text: "Read every file." }];
  rows.push({ type: "user", sessionId: session, timestamp: ts(0), message: { role: "user", content: prompt } });
  let tail = [wire("user", prompt)];
  let base: string | undefined;
  let keep = 0;
  let cached = 0;
  for (let i = 0; i < calls; i++) {
    const id = `call-${i}`;
    const breakpoint = { path: ["messages", keep + tail.length - 1, "content", 0], value: { type: "ephemeral" } };
    rows.push({
      type: "api-request",
      sessionId: session,
      id,
      timestamp: ts(i),
      querySource: "sdk",
      shapeHash,
      params: { model: "claude-opus-5-5", max_tokens: 1000 },
      ...(base === undefined ? {} : { base }),
      keep,
      tail,
      cacheControl: [breakpoint],
    });
    const write = i === 0 ? 3000 : 120;
    const usage = {
      input_tokens: 2,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
      output_tokens: 40,
    };
    cached += write;
    const use = { type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `/repo/file-${i}.txt` } };
    const message = { id: `msg_${i}`, role: "assistant", model: "claude-opus-5-5", content: [use], usage };
    rows.push({ type: "assistant", sessionId: session, requestRef: id, timestamp: ts(i), message });
    const result: Json[] = [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `line ${i}\n`.repeat(20) }];
    rows.push({ type: "user", sessionId: session, timestamp: ts(i), message: { role: "user", content: result } });
    if (sideEvery > 0 && i % sideEvery === sideEvery - 1) {
      const question: Json[] = [{ type: "text", text: `Side question ${i}?` }];
      rows.push({ type: "user", sessionId: session, timestamp: ts(i), message: { role: "user", content: question } });
      const sideId = `side-${i}`;
      const sideKeep = keep + tail.length;
      rows.push({
        type: "api-request",
        sessionId: session,
        id: sideId,
        timestamp: ts(i),
        querySource: "side_question",
        shapeHash,
        params: { model: "claude-opus-5-5", max_tokens: 1000 },
        base: id,
        keep: sideKeep,
        tail: [wire("user", question)],
        cacheControl: [{ path: ["messages", sideKeep, "content", 0], value: { type: "ephemeral" } }],
      });
      const sideUsage = {
        input_tokens: 2,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
        output_tokens: 5,
      };
      const answer = {
        id: `msg_side_${i}`,
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Yes." }],
        usage: sideUsage,
      };
      rows.push({ type: "assistant", sessionId: session, requestRef: sideId, timestamp: ts(i), message: answer });
    }
    base = id;
    keep += tail.length;
    tail = [wire("assistant", [use as unknown as Json]), wire("user", result)];
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function ts(i: number): string {
  return new Date(Date.UTC(2026, 10, 12) + i * 1000).toISOString();
}
