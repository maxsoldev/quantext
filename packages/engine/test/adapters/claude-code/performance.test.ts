/**
 * Performance guard: a 2000-call session must parse in time and memory that grow with its new content, not with
 * calls x context. Measured on the development machine (Node 22, Apple silicon) at about a tenth of the limits;
 * the limits are generous so that slower CI runners pass. Heap growth is measured without a forced GC.
 */
import { expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { syntheticSession } from "./synthetic.ts";

const CALLS = 2000;
const MAX_MS = 1500;
const MAX_HEAP_MB = 300;

test(`a ${CALLS}-call session parses in under ${MAX_MS} ms and ${MAX_HEAP_MB} MB of heap`, () => {
  const text = syntheticSession(CALLS);
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const graph = parseClaudeCodeSession({ main: text, subagents: [] });
  const ms = performance.now() - start;
  const mb = (process.memoryUsage().heapUsed - heap) / 1e6;
  expect(graph.calls).toHaveLength(CALLS);
  expect(graph.calls.filter((c) => c.issues.length > 0)).toEqual([]);
  // One run per Block, not one record per Block and Call.
  expect(graph.callBlocks.length).toBeLessThan(3 * CALLS + 10);
  expect(ms).toBeLessThan(MAX_MS);
  expect(mb).toBeLessThan(MAX_HEAP_MB);
});
