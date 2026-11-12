import { describe, expect, test } from "vitest";
import { TERMS } from "./glossary.ts";
import { overlay } from "./panel.ts";

describe("the glossary", () => {
  test("each term has its own id, a one-sentence summary and a short body", () => {
    expect(new Set(TERMS.map((t) => t.id)).size).toBe(TERMS.length);
    for (const t of TERMS) {
      expect(t.short.length, t.id).toBeLessThanOrEqual(120);
      expect(t.body.length, t.id).toBeLessThanOrEqual(520);
    }
  });

  test("each term says where the UI shows it", () => {
    for (const t of TERMS) expect(t.where?.view ?? t.where?.selector, t.id).toBeDefined();
  });

  test("the cache facts: read and write prices, lifetimes, breakpoints, order", () => {
    const text = TERMS.map((t) => `${t.short} ${t.body}`).join(" ");
    for (const fact of [
      "0.05× to 0.1×",
      "1.25×",
      "2×",
      "5 minutes",
      "1 hour",
      "up to 4",
      "tools, then the system prompt",
    ]) {
      expect(text).toContain(fact);
    }
  });
  test("the context facts: CLAUDE.md, memory and the environment are injected context, not the system prompt", () => {
    const hidden = TERMS.find((t) => t.id === "hidden-part")?.body ?? "";
    expect(hidden).not.toMatch(/system prompt \([^)]*CLAUDE\.md/);
    expect(hidden).toContain("injected context");
    // Claude Code loads the first 200 lines or 25 KB of MEMORY.md (code.claude.com/docs/en/memory).
    const memory = TERMS.find((t) => t.id === "memory")?.body ?? "";
    expect(memory).toContain("first 200 lines or 25 KB");
    expect(memory).not.toContain("every line");
  });
});

describe("the overlay", () => {
  test("opens the glossary at a term, then the keys help in its place, then closes", () => {
    const seen: string[] = [];
    const off = overlay.subscribe(() => seen.push(JSON.stringify(overlay.get())));
    overlay.glossary("compaction");
    overlay.keys();
    overlay.close();
    off();
    expect(seen).toEqual(['{"kind":"glossary","term":"compaction"}', '{"kind":"keys"}', '{"kind":"none"}']);
  });
});
