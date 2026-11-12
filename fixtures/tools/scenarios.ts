/** The recorded scenarios. Each runs in a fresh dummy repo with an isolated config (see record.ts). */

export interface Step {
  prompt: string;
  /** Extra `claude` flags for this step only. */
  args?: string[];
}

export interface Scenario {
  name: string;
  /** A fixed session id, so file names stay the same when a scenario is recorded again. */
  sessionId: string;
  description: string;
  exercises: string[];
  /** Flags for every step. `{mcpConfig}` is replaced by the path of the fixture MCP config. */
  args?: string[];
  /** The first step starts the session; each later step is `claude -p --resume <sessionId>`. */
  steps: Step[];
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "basic-tools",
    sessionId: "00000000-0000-4000-8000-000000000001",
    description: "One turn that uses the file and shell tools, one of them failing. 2.1.322 has no Glob or Grep tool.",
    exercises: [
      "Bash (find, grep, git log)",
      "parallel tool calls",
      "Read (large file, about 20 kB)",
      "Read of a missing file (tool error)",
      "Edit with a diff",
    ],
    steps: [
      {
        prompt: [
          "Do these steps in order, one tool call per step. Use the Read and Edit tools, not Bash, unless a step says Bash.",
          "1. Bash: find src -name '*.ts'",
          "2. Bash: grep -rn TODO src",
          "3. Read src/big.txt in full.",
          "4. Read missing.txt (it does not exist; that is expected, go on).",
          "5. Bash: git log --oneline",
          '6. Edit src/greet.ts: change "Hello" to "Hi".',
          "7. Read src/math.ts and README.md in parallel: both Read calls in one single message.",
          "Then reply with one word: done.",
        ].join("\n"),
      },
    ],
  },
  {
    name: "subagent",
    sessionId: "00000000-0000-4000-8000-000000000002",
    description: "The main session starts an Explore subagent that searches the repo with a few tool calls.",
    exercises: ["Agent tool", "subagent transcript", "subagent tool calls"],
    steps: [
      {
        prompt:
          "Use the Agent tool with subagent_type Explore to find which file under src/ defines the function `add` " +
          "and what it returns. Do not search yourself. Reply with the path and one line.",
      },
    ],
  },
  {
    name: "image",
    sessionId: "00000000-0000-4000-8000-000000000003",
    description: "Read of a generated PNG (96x64, three stripes), so image token counts can be tested.",
    exercises: ["Read of an image", "image block in a tool result"],
    steps: [{ prompt: "Read diagram.png with the Read tool and name its colours, left to right, in one line." }],
  },
  {
    name: "resume",
    sessionId: "00000000-0000-4000-8000-000000000004",
    description: "Three turns; each later one is a separate process, `claude -p --resume <id>`.",
    exercises: [
      "@file prompt attachment",
      "resume at a turn boundary",
      "keep and tail across processes",
      "built-in skill loaded with the Skill tool",
    ],
    steps: [
      { prompt: "Summarise @notes.txt in one line." },
      { prompt: "How many list items does notes.txt have? Answer from what you read before, with one number." },
      {
        prompt:
          "Use the Skill tool to load the built-in keybindings-help skill, then say in one line what it covers. " +
          "Change no files.",
      },
    ],
  },
  {
    name: "compaction",
    sessionId: "00000000-0000-4000-8000-000000000005",
    description: "A turn with tool output, then `/compact` headless through resume, then a turn after the compaction.",
    exercises: ["manual compaction (/compact)", "compact summary", "a call after compaction"],
    steps: [
      { prompt: "Read src/big.txt and notes.txt, then reply with the number of lines in each." },
      { prompt: "/compact" },
      { prompt: "Which two files did you read earlier? Reply with the names only." },
    ],
  },
  {
    name: "mcp-deferred",
    sessionId: "00000000-0000-4000-8000-000000000006",
    description: "A local stdio MCP server; its tool is deferred, loaded with ToolSearch, then called once.",
    exercises: ["deferred MCP tool", "ToolSearch", "MCP tool call"],
    args: ["--mcp-config", "{mcpConfig}"],
    steps: [
      {
        prompt:
          "Use the lookup_word tool of the dictionary MCP server to look up the word cobalt. " +
          "Reply with its result only.",
      },
    ],
  },
  {
    name: "effort",
    sessionId: "00000000-0000-4000-8000-000000000007",
    description: "Three turns with different thinking parameters, so the call parameters vary in one session.",
    exercises: ["effort high (Opus)", "effort low (Opus)", "budget thinking on Sonnet (model change on resume)"],
    steps: [
      {
        prompt: "Without tools: a train leaves at 09:47 and the trip takes 2 h 38 min. When does it arrive? Time only.",
        args: ["--effort", "high"],
      },
      { prompt: "And if the trip took 25 minutes longer? Time only.", args: ["--effort", "low"] },
      { prompt: "And if it left 10 minutes later than that? Time only.", args: ["--model", "sonnet"] },
    ],
  },
];
