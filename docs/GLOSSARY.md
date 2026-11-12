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
One request from the harness to the model, with the response and its usage. The model and the parameters (max
tokens, thinking, effort, betas) belong to the Call, not to its Shape.
_Avoid_: turn, request, message, step

**Usage**:
The token counts that the model provider reports for one Call: input, cache read, cache write and output.
_Avoid_: token stats, metrics

**Shape**:
The system prompt blocks and the tool schemas of a Call's request, identified by its shape hash. Many Calls share one
Shape; it is stored once (in Claude Code logs: the `api-request-shape` row).
_Avoid_: signature, config, header

**Compaction**:
An event where the harness replaces most of a Session's context with a shorter summary, to free room. The Call
that writes the summary is the **summarising Call**; when the harness does not log it, its Usage is derived.
_Avoid_: summarisation, truncation, reset

## Context

**Blob**:
One message of a Call's message list, stored once by the hash of its content (in Claude Code logs: the
`api-request-blob` row).
_Avoid_: message body, payload

**Block**:
One unique piece of content sent to the model (a system prompt, a tool schema, a user message, a tool result, and so
on). The same content in many Calls is one Block.
_Avoid_: chunk, segment, message, part

**Block kind**:
What a Block is by its role in the request: a tool schema, a system block, a user text, a reminder, an assistant
text, reasoning, a tool call, a tool result, an image, a document, or a summary. A **reminder** is text that the
harness adds to a message for the model, not typed by the user: context, notices, an attached file, a skill's text.
A **summary** is the text that replaces the context after a Compaction.
_Avoid_: type (the provider's content block type is a different, finer thing)

**Block source**:
Where a Block's content came from, as far as the log tells: the tool, the file it read or wrote, the MCP server,
the skill.
_Avoid_: origin, provenance

**CallBlock**:
A run of one Block at one position in the Calls of one lane, while its place and tokens stay the same: from a first
Call to a last Call (or on to the lane's latest Call). The input of Call N is every CallBlock that covers N.
_Avoid_: occurrence, usage (Usage means token counts)

**Lane**:
The Calls of a Session that build on each other's context: one model, one purpose (the main loop, a side query).
CallBlocks span the Calls of one lane.
_Avoid_: thread, branch, stream

**Group**:
Blocks whose tokens were split by estimate from one exact total, so their sum is exact even where each share is not.
_Avoid_: batch, cluster

**ToolCall**:
One use of a tool by the model: the tool, its input, and the Block that holds its result.
_Avoid_: tool use, function call, action

**Keep**:
The number of messages, from the start of the previous Call's message list, that a Call keeps unchanged.
_Avoid_: history, carry-over

**Tail**:
The list of Blob hashes that a Call appends after the kept messages. The messages of Call N are the first Keep
messages of Call N−1, then the Blobs of the Tail.
_Avoid_: delta, diff, new messages

**Cache breakpoint**:
A place in a Call's request that carries a `cache_control` marker, recorded as its path in the request. The model
provider caches the request up to each breakpoint.
_Avoid_: cache marker, cacheControl (that is the field that holds the paths)

**Cached prefix**:
The leading part of a Call's input that the model provider read from its cache instead of processing again. A Block
is in it only when it ends inside the cache read.
_Avoid_: cache hit, warm part

## Numbers

**Token basis**:
How a token number was found: `exact` (from Usage), `derived` (computed from exact counters, such as the change of a
running total, when a Call's own Usage is not logged) or `estimate` (from an estimator, used only to split an exact
or derived total).
_Avoid_: precision, confidence, source

**Framing tokens**:
Input tokens of a Call that belong to no Block: the end of the request after its last Block. A Call's CallBlocks
and its framing tokens add up to its input total.
_Avoid_: overhead, padding

**Lifetime cost**:
What one Block costs over all the Calls it appears in, in tokens or money.
_Avoid_: total cost, cumulative tokens
