# Quantext

Quantext rebuilds what a coding agent's model received on every call, and shows where the context tokens go. These
terms are harness-neutral: they mean the same thing for Claude Code, Codex or any later harness.

## Sessions and calls

**Harness**:
The coding agent program that talks to the model and writes the session logs, for example Claude Code or Codex.
_Avoid_: agent (when you mean the program), client, tool

**Session**:
One conversation in a harness, from its start to its end. A subagent run is its own Session, with the Session that
started it as its parent.
_Avoid_: conversation, transcript, thread, chat

**Call**:
One request from the harness to the model, with the response and its usage.
_Avoid_: turn, request, message, step

**Usage**:
The token counts that the model provider reports for one Call: input, cache read, cache write and output.
_Avoid_: token stats, metrics

**Shape**:
The structure of a Call's request apart from the conversation content: model, parameters, system prompt and tool
schemas. When the shape changes, the cache cannot be reused.
_Avoid_: signature, config

**Compaction**:
An event where the harness replaces most of a Session's context with a shorter summary, to free room.
_Avoid_: summarisation, truncation, reset

## Context

**Block**:
One unique piece of content sent to the model (a system prompt, a tool schema, a user message, a tool result, and so
on). The same content in many Calls is one Block.
_Avoid_: chunk, segment, message, part

**CallBlock**:
One appearance of a Block in a Call, at a position in that Call's input.
_Avoid_: occurrence, usage (Usage means token counts)

**ToolCall**:
One use of a tool by the model: the tool, its input, and the Block that holds its result.
_Avoid_: tool use, function call, action

**Keep**:
The part of a Call's input that the harness carried over unchanged from the previous Call.
_Avoid_: history, carry-over

**Tail**:
The part of a Call's input that is new since the previous Call.
_Avoid_: delta, diff, new messages

**Cached prefix**:
The leading part of a Call's input that the model provider read from its cache instead of processing again.
_Avoid_: cache hit, warm part

## Numbers

**Token basis**:
How a token number was found: `exact` (from Usage) or `estimate` (from a tokenizer, used only to split an exact
total).
_Avoid_: precision, confidence, source

**Lifetime cost**:
What one Block costs over all the Calls it appears in, in tokens or money.
_Avoid_: total cost, cumulative tokens
