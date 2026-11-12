/**
 * A tiny MCP server over stdio (newline-delimited JSON-RPC), for the deferred-tool scenario.
 * One tool, `lookup_word`, answers from a fixed word list. No network, no dependencies.
 */
import { createInterface } from "node:readline";

const WORDS: Record<string, string> = {
  cobalt: "A blue-grey metal, element 27.",
  lantern: "A portable case that holds a light.",
};

const TOOL = {
  name: "lookup_word",
  description: "Look up the meaning of a word in the fixture dictionary.",
  inputSchema: {
    type: "object",
    properties: { word: { type: "string", description: "The word to look up" } },
    required: ["word"],
  },
};

type Request = { id?: number | string; method: string; params?: Record<string, unknown> };

function answer(request: Request): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-dictionary", version: "1.0.0" },
      };
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      const args = (request.params?.arguments ?? {}) as { word?: string };
      const word = String(args.word ?? "").toLowerCase();
      const text = WORDS[word] ?? `No entry for "${word}".`;
      return { content: [{ type: "text", text }], isError: WORDS[word] === undefined };
    }
    case "ping":
      return {};
    default:
      return undefined;
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line) as Request;
  if (request.id === undefined) return; // a notification, such as notifications/initialized
  const result = answer(request);
  const reply =
    result === undefined
      ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } }
      : { jsonrpc: "2.0", id: request.id, result };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
