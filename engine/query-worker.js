import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
// packages/engine/src/providers/anthropic/estimate.ts
/** Width and height from the header of a base64 PNG, GIF, JPEG or WebP image; undefined for other data. */
function imageSize(base64) {
	const bytes = decodeBase64(base64);
	if (bytes === void 0) return void 0;
	const at = (i) => bytes[i] ?? 0;
	const be16 = (i) => at(i) << 8 | at(i + 1);
	const le16 = (i) => at(i) | at(i + 1) << 8;
	const be32 = (i) => be16(i) * 65536 + be16(i + 2);
	const ascii = (i, n) => String.fromCharCode(...bytes.subarray(i, i + n));
	if (ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return {
		width: be32(16),
		height: be32(20)
	};
	if (ascii(0, 4) === "GIF8") return {
		width: le16(6),
		height: le16(8)
	};
	if (at(0) === 255 && at(1) === 216) return jpegSize(bytes, be16);
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return webpSize(ascii(12, 4), at, le16);
}
/** Walk the JPEG segments to the first start-of-frame marker (SOF0..SOF15 without DHT, JPG and DAC). */
function jpegSize(bytes, be16) {
	let i = 2;
	while (i + 8 < bytes.length && bytes[i] === 255) {
		const marker = bytes[i + 1] ?? 0;
		if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) return {
			width: be16(i + 7),
			height: be16(i + 5)
		};
		i += 2 + be16(i + 2);
	}
}
function webpSize(chunk, at, le16) {
	const le24 = (i) => at(i) | at(i + 1) << 8 | at(i + 2) << 16;
	if (chunk === "VP8 ") return {
		width: le16(26) & 16383,
		height: le16(28) & 16383
	};
	if (chunk === "VP8L") {
		const bits = at(21) | at(22) << 8 | at(23) << 16 | at(24) << 24;
		return {
			width: (bits & 16383) + 1,
			height: (bits >> 14 & 16383) + 1
		};
	}
	if (chunk === "VP8X") return {
		width: le24(24) + 1,
		height: le24(27) + 1
	};
}
/** Image headers are read from the first 64 KB at most (a JPEG frame header may follow large metadata). */
const HEADER_BASE64_CHARS = 87380;
function decodeBase64(base64) {
	const head = base64.slice(0, HEADER_BASE64_CHARS);
	const whole = head.slice(0, head.length - head.length % 4);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(whole)) return void 0;
	const binary = atob(whole);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
// packages/engine/src/providers/anthropic/content.ts
/** The display text of one content block, tool schema or system block. */
function blockText(content) {
	const block = asObject(content);
	if (block === void 0) return typeof content === "string" ? content : JSON.stringify(content);
	if (typeof block.name === "string" && "input_schema" in block) return `${block.name}: ${String(block.description ?? "")}`;
	switch (block.type) {
		case "text": return String(block.text ?? "");
		case "thinking": return block.thinking ? String(block.thinking) : "[reasoning]";
		case "redacted_thinking": return "[reasoning]";
		case "tool_use": return `${String(block.name ?? "")} ${JSON.stringify(block.input ?? null)}`;
		case "tool_result": {
			const inner = block.content;
			if (typeof inner === "string") return inner;
			return Array.isArray(inner) ? inner.map(blockText).join("\n") : "";
		}
		case "tool_reference": return `[tool ${String(block.tool_name ?? "")}]`;
		case "image": {
			const data = asObject(block.source)?.data;
			const size = typeof data === "string" ? imageSize(data) : void 0;
			return size === void 0 ? "[image]" : `[image ${size.width}x${size.height}]`;
		}
		case "document": return "[document]";
		default: return JSON.stringify(content);
	}
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
// packages/engine/src/core/pricing.ts
/**
* Each Block's share of a Call's input cost, from its tokens in order. The provider reads the cache first, then
* writes the cache up to the last breakpoint, then reads the rest as plain input: a Block is priced by the parts
* of that range it covers (the cache write at its average price over both times to live).
*/
function blockCosts(tokens, usage, cost) {
	const perToken = (usd, n) => n > 0 ? usd / n : 0;
	const readEnd = usage.cacheReadTokens;
	const writeEnd = readEnd + usage.cacheWriteTokens;
	const prices = [
		{
			from: 0,
			to: readEnd,
			price: perToken(cost.cacheReadUsd, usage.cacheReadTokens)
		},
		{
			from: readEnd,
			to: writeEnd,
			price: perToken(cost.cacheWriteUsd, usage.cacheWriteTokens)
		},
		{
			from: writeEnd,
			to: Number.POSITIVE_INFINITY,
			price: perToken(cost.inputUsd, usage.inputTokens)
		}
	];
	let start = 0;
	return tokens.map((t) => {
		const [a, b] = [start, start + t];
		start = b;
		return prices.reduce((usd, r) => usd + Math.max(0, Math.min(b, r.to) - Math.max(a, r.from)) * r.price, 0);
	});
}
// packages/engine/src/providers/anthropic/pricing.ts
const p = (input, output, cacheRead, more = {}) => ({
	input,
	output,
	cacheRead,
	regionalPremium: true,
	usOnlyPremium: true,
	longContextVerified: true,
	...more
});
const BEFORE_4_6 = {
	usOnlyPremium: false,
	longContextVerified: false
};
const BEFORE_4_5 = {
	...BEFORE_4_6,
	regionalPremium: false
};
p(8, 40, .2, { fast: {
	input: 16,
	output: 80
} }), p(8, 40, .2, { fast: {
	input: 16,
	output: 80
} }), p(10, 50, .25), p(10, 50, .25), p(10, 50, 1), p(10, 50, 1), p(4, 20, .2, { fast: {
	input: 8,
	output: 40
} }), p(5, 25, .5, { fast: {
	input: 10,
	output: 50
} }), p(5, 25, .5, { fast: {
	input: 10,
	output: 50
} }), p(5, 25, .5), p(5, 25, .5), p(5, 25, .5, BEFORE_4_6), p(15, 75, 1.5, BEFORE_4_5), p(15, 75, 1.5, BEFORE_4_5), p(2, 10, .1), p(2, 10, .2), p(3, 15, .3), p(3, 15, .3, BEFORE_4_6), p(3, 15, .3, BEFORE_4_5), p(.1, .5, .01, { longPrompt: {
	over: 1e5,
	input: .5,
	output: 2.5,
	cacheRead: .05
} }), p(1, 5, .1, BEFORE_4_6);
// packages/engine/src/adapters/claude-code/json.ts
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : void 0;
}
// packages/engine/src/adapters/claude-code/hash.ts
/** Claude Code's content hash: sha256 of the JSON with object keys sorted at every level. */
function sha256Sorted(value) {
	return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isObject(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key] ?? null)]));
}
// packages/engine/src/adapters/claude-code/classify.ts
/** The display text of a gap Block. */
function gapText(messageHash) {
	return `Message ${messageHash} is not in the log`;
}
/** The hash of a content block, with the role it is sent in (so equal text as system and as user stays apart). */
function blockHash(role, content) {
	return sha256Sorted({
		role,
		block: content
	});
}
// packages/engine/src/core/attribute.ts
/**
* Integer shares of `total` in proportion to the estimates, adding up to `total` exactly (largest remainder).
* `rest` and `unknown` Blocks share what the known estimates leave (`rest` by tokens, `unknown` equally); with no
* weight at all, shares are equal.
*/
function reconcile(estimates, total) {
	const leftover = (e) => e.method === "unknown" || e.method === "rest";
	const known = estimates.reduce((sum, e) => sum + (leftover(e) ? 0 : e.tokens), 0);
	let weights = estimates.map((e) => leftover(e) ? 0 : e.tokens);
	if (estimates.some(leftover) && known < total) {
		const rest = estimates.filter((e) => e.method === "rest");
		const restWeight = rest.reduce((sum, e) => sum + e.tokens, 0);
		const unknownWeight = Math.max(1, rest.length === 0 ? 1 : restWeight / rest.length);
		const parts = estimates.map((e) => e.method === "rest" ? e.tokens : e.method === "unknown" ? unknownWeight : 0);
		const partSum = parts.reduce((a, b) => a + b, 0);
		const share = (part) => partSum === 0 ? (total - known) / estimates.filter(leftover).length : (total - known) * part / partSum;
		weights = estimates.map((e, i) => leftover(e) ? share(parts[i] ?? 0) : e.tokens);
	}
	if (weights.reduce((a, b) => a + b, 0) === 0) weights = estimates.map(() => 1);
	const sum = weights.reduce((a, b) => a + b, 0);
	const exact = weights.map((w) => sum === 0 ? 0 : w * total / sum);
	const shares = exact.map(Math.floor);
	const left = total - shares.reduce((a, b) => a + b, 0);
	const order = exact.map((x, i) => ({
		i,
		frac: x - Math.floor(x)
	})).sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (let k = 0; k < left; k++) {
		const target = order[k % order.length];
		if (target !== void 0) shares[target.i] = (shares[target.i] ?? 0) + 1;
	}
	return shares;
}
// packages/engine/src/adapters/claude-code/stored.ts
/**
* The Claude Code records as the store keeps them: a message (`m:`) and a shape (`s:`) become lists of content
* blocks by Block hash (the hash the classifier gives each block), so the store keeps each content block once.
*/
const parts = (role, content) => content.map((c) => ({
	hash: blockHash(role, c),
	content: c
}));
/** Base64 data shorter than this stays in the content. */
const MEDIA_MIN_CHARS = 128;
const claudeCodeCodec = {
	version: 11,
	pack({ key, value }) {
		if (key.startsWith("m:")) {
			const message = value;
			return {
				kind: "message",
				key,
				role: message.role,
				parts: parts(message.role, message.content)
			};
		}
		if (key.startsWith("s:")) {
			const shape = value;
			return {
				kind: "shape",
				key,
				tools: parts("tools", shape.tools),
				system: parts("system", shape.system)
			};
		}
		return {
			kind: "value",
			key,
			value
		};
	},
	unpack(stored) {
		switch (stored.kind) {
			case "message": return {
				role: stored.role,
				content: stored.parts.map((p) => p.content)
			};
			case "shape": return {
				system: stored.system.map((p) => p.content),
				tools: stored.tools.map((p) => p.content)
			};
			case "value": return stored.value;
		}
	},
	packContent(content) {
		const media = [];
		return {
			content: mapSources(content, (source) => takeMedia(source, media)),
			media
		};
	},
	unpackContent(content, bytes) {
		return mapSources(content, (source) => {
			const hash = str(source.$media);
			if (hash === void 0 || source.data !== void 0) return source;
			const { $media: _, ...rest } = source;
			return {
				...rest,
				data: Buffer.from(bytes(hash)).toString("base64")
			};
		});
	},
	text(content) {
		const gap = isObject(content) && content.type === "gap" ? str(content.message) : void 0;
		return gap === void 0 ? blockText(content) : gapText(gap);
	}
};
/** The content with every `{ type: "base64", … }` source object passed through `map`. */
function mapSources(value, map) {
	if (Array.isArray(value)) return value.map((v) => mapSources(v, map));
	if (!isObject(value)) return value;
	const out = {};
	for (const [key, child] of Object.entries(value)) out[key] = mapSources(child ?? null, map);
	return out.type === "base64" ? map(out) : out;
}
/** A base64 source of canonical, long data, as a reference to its decoded bytes (added to `media`). */
function takeMedia(source, media) {
	const data = str(source.data);
	const mediaType = str(source.media_type);
	if (data === void 0 || mediaType === void 0 || data.length < MEDIA_MIN_CHARS) return source;
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) return source;
	const hash = createHash("sha256").update(bytes).digest("hex");
	media.push({
		hash,
		mediaType,
		bytes
	});
	const { data: _, ...rest } = source;
	return {
		...rest,
		$media: hash
	};
}
// packages/engine/src/query/categories.ts
const CATEGORIES = [
	"tool-definitions",
	"base-instructions",
	"injected-context",
	"user",
	"assistant",
	"reasoning",
	"tool-calls",
	"tool-outputs",
	"compaction-summary",
	"other"
];
/**
* The group of a Block, by its kind and the section it is in: a system text in the messages (a harness notice) is
* injected context; a tool schema in the messages (loaded by a tool search) is still a tool definition, marked
* deferred by `isDeferred`. An image or document counts as a tool output when a tool gave it, else as the user's.
*/
function categoryOf(kind, section, source) {
	switch (kind) {
		case "tool-schema": return "tool-definitions";
		case "system": return section === "messages" ? "injected-context" : "base-instructions";
		case "reminder": return "injected-context";
		case "user": return "user";
		case "assistant": return "assistant";
		case "reasoning": return "reasoning";
		case "tool-call": return "tool-calls";
		case "tool-result": return "tool-outputs";
		case "image":
		case "document": return source.tool === void 0 ? "user" : "tool-outputs";
		case "summary": return "compaction-summary";
		default: return "other";
	}
}
/** Every group at 0 tokens. */
function emptyCategories() {
	return Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
}
/** A tool schema that is not in the request's tools but sent later, in the messages (a deferred tool, loaded). */
function isDeferred(kind, section) {
	return kind === "tool-schema" && section === "messages";
}
// packages/engine/src/store/driver.ts
const BUSY_TIMEOUT_MS = 5e3;
/**
* Open (or create) a database file with the runtime's built-in SQLite, with no settings changed. Each driver stays
* behind its own import(): the bundle keeps it a chunk of its own, so a runtime never loads the other's module.
*/
async function openRaw(path, options = {}) {
	return process.versions.bun === void 0 ? (await import("./query-worker-node-driver.js")).openNode(path, options) : (await import("./query-worker-bun-driver.js")).openBun(path, options);
}
/**
* Open an existing database file read-only: the file is opened read-only, `setup` runs (temporary views), and then
* `query_only` stops every write, also to the temporary schema. Writes still fail inside `transaction`.
*/
async function openReadOnlyDriver(path, setup, readsOnly = false) {
	const raw = await openRaw(path, { readOnly: true });
	try {
		raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const db = withTransactions(raw);
		setup?.(db);
		raw.exec("PRAGMA query_only = 1");
		if (readsOnly) raw.denyAllButReads();
		return db;
	} catch (error) {
		raw.close();
		throw error;
	}
}
function withTransactions(raw) {
	let open = false;
	return {
		runtime: raw.runtime,
		exec: (sql) => raw.exec(sql),
		prepare: (sql) => raw.prepare(sql),
		close: () => raw.close(),
		transaction(work) {
			if (open) throw new Error("transactions do not nest");
			open = true;
			raw.exec("BEGIN IMMEDIATE");
			try {
				const result = work();
				raw.exec("COMMIT");
				return result;
			} catch (error) {
				if (raw.inTransaction()) try {
					raw.exec("ROLLBACK");
				} catch (rollback) {
					throw new AggregateError([error, rollback], `rollback failed after: ${String(error)}`);
				}
				throw error;
			} finally {
				open = false;
			}
		}
	};
}
const SCHEMA_VERSION = 5;
// packages/engine/src/store/rows.ts
const SESSION_COLUMNS = [
	"id",
	"parent_id",
	"harness",
	"harness_version",
	"project",
	"cwd",
	"started",
	"ended",
	"request_log",
	"title",
	"title_source",
	"agent_name"
];
const CALL_COLUMNS = [
	"id",
	"session_id",
	"idx",
	"lane",
	"ts",
	"model",
	"canonical_model",
	"params",
	"shape_hash",
	"usage_basis",
	"input_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cache_write_5m_tokens",
	"cache_write_1h_tokens",
	"output_tokens",
	"reasoning_output_tokens",
	"speed",
	"service_tier",
	"inference_geo",
	"cost_input_usd",
	"cost_cache_read_usd",
	"cost_cache_write_usd",
	"cost_output_usd",
	"cost_total_usd",
	"price_model",
	"price_source",
	"price_date",
	"price_modifiers",
	"block_count",
	"cache_breakpoints",
	"cache_boundary_tokens",
	"cache_boundary_position",
	"framing_tokens",
	"issues",
	"turn_duration_ms",
	"response"
];
function call$1(r) {
	const c = {
		id: text(r.id),
		sessionId: text(r.session_id),
		index: Number(r.idx),
		ts: text(r.ts),
		model: text(r.model),
		params: json$1(r.params),
		lane: text(r.lane),
		cacheBreakpoints: json$1(r.cache_breakpoints),
		framingTokens: Number(r.framing_tokens),
		issues: json$1(r.issues)
	};
	put(c, "canonicalModel", r.canonical_model);
	put(c, "shapeHash", r.shape_hash);
	if (r.usage_basis !== null) {
		const usage = {
			basis: text(r.usage_basis),
			inputTokens: Number(r.input_tokens),
			cacheReadTokens: Number(r.cache_read_tokens),
			cacheWriteTokens: Number(r.cache_write_tokens),
			outputTokens: Number(r.output_tokens)
		};
		putNumber(usage, "cacheWrite5mTokens", r.cache_write_5m_tokens);
		putNumber(usage, "cacheWrite1hTokens", r.cache_write_1h_tokens);
		putNumber(usage, "reasoningOutputTokens", r.reasoning_output_tokens);
		c.usage = usage;
	}
	put(c, "speed", r.speed);
	put(c, "serviceTier", r.service_tier);
	put(c, "inferenceGeo", r.inference_geo);
	if (r.cost_total_usd !== null) c.cost = {
		inputUsd: Number(r.cost_input_usd),
		cacheReadUsd: Number(r.cost_cache_read_usd),
		cacheWriteUsd: Number(r.cost_cache_write_usd),
		outputUsd: Number(r.cost_output_usd),
		totalUsd: Number(r.cost_total_usd),
		price: {
			model: text(r.price_model),
			source: text(r.price_source),
			date: text(r.price_date),
			modifiers: json$1(r.price_modifiers)
		}
	};
	putNumber(c, "blockCount", r.block_count);
	if (r.cache_boundary_tokens !== null) c.cacheBoundary = {
		tokens: Number(r.cache_boundary_tokens),
		position: Number(r.cache_boundary_position)
	};
	putNumber(c, "turnDurationMs", r.turn_duration_ms);
	if (r.response !== null && r.response !== void 0) c.response = json$1(r.response);
	return c;
}
const LOG_BLOCK_COLUMNS = [
	"hash",
	"kind",
	"tool",
	"file_path",
	"mcp_server",
	"skill",
	"attachment",
	"parts"
];
const RUN_COLUMNS = [
	"id",
	"session_id",
	"lane",
	"block_hash",
	"position",
	"section",
	"message",
	"tokens",
	"basis",
	"grp",
	"first_call",
	"last_call"
];
function run(r) {
	const out = {
		id: text(r.id),
		sessionId: text(r.session_id),
		lane: text(r.lane),
		blockHash: text(r.block_hash),
		position: Number(r.position),
		section: text(r.section),
		firstCall: Number(r.first_call)
	};
	putNumber(out, "message", r.message);
	putNumber(out, "tokens", r.tokens);
	if (r.basis !== null) out.basis = text(r.basis);
	put(out, "group", r.grp);
	putNumber(out, "lastCall", r.last_call);
	return out;
}
const TOOL_CALL_COLUMNS = [
	"id",
	"session_id",
	"call_id",
	"name",
	"input",
	"block_hash",
	"tool",
	"file_path",
	"mcp_server",
	"skill",
	"attachment",
	"result_block_hash",
	"is_error",
	"duration_ms",
	"parallel",
	"child_session_id"
];
/** A ToolCall from its row; `content` gives a Block's content, for an input stored by its Block. */
function toolCall(r, content) {
	const fromBlock = r.input === null ? content(text(r.block_hash)) : void 0;
	const t = {
		id: text(r.id),
		sessionId: text(r.session_id),
		callId: text(r.call_id),
		name: text(r.name),
		input: r.input === null ? fromBlock?.input ?? null : json$1(r.input),
		source: source(r),
		isError: Number(r.is_error) === 1,
		parallel: Number(r.parallel)
	};
	put(t, "blockHash", r.block_hash);
	put(t, "resultBlockHash", r.result_block_hash);
	putNumber(t, "durationMs", r.duration_ms);
	put(t, "childSessionId", r.child_session_id);
	return t;
}
const COMPACTION_COLUMNS = [
	"id",
	"session_id",
	"ts",
	"trigger",
	"before_tokens",
	"after_tokens",
	"before_call_id",
	"summary_call_id"
];
function compaction(r) {
	const c = {
		id: text(r.id),
		sessionId: text(r.session_id),
		ts: text(r.ts),
		trigger: text(r.trigger)
	};
	putNumber(c, "beforeTokens", r.before_tokens);
	putNumber(c, "afterTokens", r.after_tokens);
	put(c, "beforeCallId", r.before_call_id);
	put(c, "summaryCallId", r.summary_call_id);
	return c;
}
const EVENT_COLUMNS = [
	"id",
	"session_id",
	"ts",
	"kind",
	"value",
	"detail"
];
function event(r) {
	const e = {
		id: text(r.id),
		sessionId: text(r.session_id),
		kind: text(r.kind),
		value: text(r.value)
	};
	put(e, "ts", r.ts);
	if (r.detail !== null) e.detail = json$1(r.detail);
	return e;
}
function source(r) {
	const s = {};
	put(s, "tool", r.tool);
	put(s, "filePath", r.file_path);
	put(s, "mcpServer", r.mcp_server);
	put(s, "skill", r.skill);
	put(s, "attachment", r.attachment);
	return s;
}
/** A JSON column, parsed; `T` is what the store wrote there. */
function json$1(value) {
	return JSON.parse(text(value));
}
function text(value) {
	return typeof value === "string" ? value : String(value);
}
/** Set an optional text field from a column, leaving it out when the column is NULL. */
function put(target, key, value) {
	if (value !== null && value !== void 0) target[key] = text(value);
}
function putNumber(target, key, value) {
	if (value !== null && value !== void 0) target[key] = Number(value);
}
// packages/engine/src/store/statements.ts
/** An insert of one row of a log's table that replaces the columns of the row with the same (log, key). */
function upsertSql(table, columns, key = ["id"]) {
	const updates = columns.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
	return `INSERT INTO ${table} (log, ${columns.join(", ")}) VALUES (?${", ?".repeat(columns.length)})
    ON CONFLICT (log, ${key.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}
upsertSql("sessions", SESSION_COLUMNS);
upsertSql("calls", CALL_COLUMNS);
upsertSql("call_blocks", RUN_COLUMNS, [
	"session_id",
	"lane",
	"first_call",
	"position"
]);
upsertSql("tool_calls", TOOL_CALL_COLUMNS);
upsertSql("compactions", COMPACTION_COLUMNS);
upsertSql("session_events", EVENT_COLUMNS);
upsertSql("messages", [
	"key",
	"role",
	"blocks"
], ["key"]);
upsertSql("shapes", [
	"key",
	"tools",
	"system"
], ["key"]);
upsertSql("records", ["key", "value"], ["key"]);
upsertSql("log_blocks", LOG_BLOCK_COLUMNS, ["hash"]);
// packages/engine/src/store/store.ts
/** The store: one SQLite database in the data folder, written by one engine at a time. */
/**
* Open the store of a data folder read-only, with no writer lock: for the query layer and `qx sql`, also while an
* engine writes. The file is opened read-only and `query_only` is set, so no statement can change it.
*/
async function openReader(dataDir, options = {}) {
	const path = join(dataDir, "quantext.db");
	if (!existsSync(path)) throw new Error(`there is no store in ${dataDir}: run \`qx ingest\` first`);
	return openReadOnlyDriver(path, (db) => {
		const version = Number(db.prepare("SELECT version FROM schema_version").get()?.version ?? 0);
		if (version !== SCHEMA_VERSION) throw new Error(`the store's schema version is ${version}, this engine reads ${SCHEMA_VERSION}: run \`qx ingest\` to migrate it`);
		options.setup?.(db);
	}, options.readsOnly === true);
}
// packages/engine/src/query/lifetimes.ts
/** The per-Call parts summed over the Calls where a run lies after the boundary (each times T). */
const PARTS = 5;
/** A Fenwick tree of `PARTS` sums over the places 0..n-1 of a lane. */
var Fenwick = class {
	#sums;
	#n;
	constructor(n) {
		this.#n = n;
		this.#sums = new Float64Array((n + 1) * PARTS);
	}
	add(place, values) {
		for (let i = place + 1; i <= this.#n; i += i & -i) for (let k = 0; k < PARTS; k++) this.#sums[i * PARTS + k] = (this.#sums[i * PARTS + k] ?? 0) + (values[k] ?? 0);
	}
	/** The sums over places [0, end). */
	prefix(end, out) {
		out.fill(0);
		for (let i = end; i > 0; i -= i & -i) for (let k = 0; k < PARTS; k++) out[k] = (out[k] ?? 0) + (this.#sums[i * PARTS + k] ?? 0);
	}
};
/** The first place in sorted `xs` whose value is at least `x`. */
function lowerBound(xs, x) {
	let lo = 0;
	let hi = xs.length;
	while (lo < hi) {
		const mid = lo + hi >> 1;
		if ((xs[mid] ?? 0) < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
/** Each Block's lifetime over the Session's runs and Calls. */
function lifetimes(calls, runs) {
	const lanes = /* @__PURE__ */ new Map();
	for (const c of calls) {
		const lane = lanes.get(c.lane) ?? [];
		lane.push(c);
		lanes.set(c.lane, lane);
	}
	const sums = /* @__PURE__ */ new Map();
	const runsByLane = /* @__PURE__ */ new Map();
	for (const r of runs) {
		const list = runsByLane.get(r.lane) ?? [];
		list.push(r);
		runsByLane.set(r.lane, list);
	}
	for (const [laneName, laneRuns] of runsByLane) {
		const laneCalls = (lanes.get(laneName) ?? []).slice().sort((x, y) => x.idx - y.idx);
		const idxs = laneCalls.map((c) => c.idx);
		const readPrefix = new Float64Array(laneCalls.length + 1);
		laneCalls.forEach((c, i) => {
			readPrefix[i + 1] = (readPrefix[i] ?? 0) + (c.unitRead ?? 0);
		});
		/** The places [from, to) of the Calls in the run's range. */
		const span = (r) => [lowerBound(idxs, r.firstCall), r.lastCall === null ? idxs.length : lowerBound(idxs, r.lastCall + 1)];
		for (const r of laneRuns) {
			const [from, to] = span(r);
			sums.set(r, {
				calls: to - from,
				unitRead: (readPrefix[to] ?? 0) - (readPrefix[from] ?? 0),
				rest: 0,
				restRead: 0,
				restUsd: 0,
				wr: 0,
				wrUsd: 0
			});
		}
		const bounded = laneCalls.map((c, place) => ({
			c,
			place
		})).filter((x) => x.c.boundary !== null).sort((x, y) => (x.c.boundary ?? 0) - (y.c.boundary ?? 0));
		const tree = new Fenwick(laneCalls.length);
		const hi = new Float64Array(PARTS);
		const lo = new Float64Array(PARTS);
		let next = 0;
		for (const r of [...laneRuns].sort((x, y) => x.position - y.position)) {
			while (next < bounded.length && (bounded[next]?.c.boundary ?? 0) < r.position) {
				const { c, place } = bounded[next];
				const wrote = (c.cacheWrite ?? 0) > 0;
				tree.add(place, [
					1,
					c.unitRead ?? 0,
					c.unitRest ?? 0,
					wrote ? 1 : 0,
					wrote ? c.unitRest ?? 0 : 0
				]);
				next++;
			}
			if (r.tokens === null) continue;
			const [from, to] = span(r);
			tree.prefix(to, hi);
			tree.prefix(from, lo);
			const s = sums.get(r);
			const t = r.tokens;
			s.rest += t * ((hi[0] ?? 0) - (lo[0] ?? 0));
			s.restRead += t * ((hi[1] ?? 0) - (lo[1] ?? 0));
			s.restUsd += t * ((hi[2] ?? 0) - (lo[2] ?? 0));
			s.wr += t * ((hi[3] ?? 0) - (lo[3] ?? 0));
			s.wrUsd += t * ((hi[4] ?? 0) - (lo[4] ?? 0));
		}
		const atPosition = /* @__PURE__ */ new Map();
		for (const r of laneRuns) {
			const list = atPosition.get(r.position) ?? [];
			list.push(r);
			atPosition.set(r.position, list);
		}
		for (const list of atPosition.values()) list.sort((x, y) => x.firstCall - y.firstCall);
		for (const c of laneCalls) {
			if (c.boundary === null || c.offset === null || c.cacheRead === null) continue;
			const list = atPosition.get(c.boundary);
			if (list === void 0) continue;
			const r = list[lowerBound(list.map((r) => r.firstCall), c.idx + 1) - 1];
			if (r === void 0 || r.tokens === null || r.lastCall !== null && r.lastCall < c.idx) continue;
			const rest = r.tokens - Math.min(r.tokens, Math.max(0, c.cacheRead - c.offset));
			const s = sums.get(r);
			s.rest += rest;
			s.restRead += rest * (c.unitRead ?? 0);
			s.restUsd += rest * (c.unitRest ?? 0);
			if ((c.cacheWrite ?? 0) > 0) {
				s.wr += rest;
				s.wrUsd += rest * (c.unitRest ?? 0);
			}
		}
	}
	const out = /* @__PURE__ */ new Map();
	for (const [r, s] of sums) {
		const t = r.tokens ?? 0;
		const row = out.get(r.blockHash) ?? {
			block_hash: r.blockHash,
			runs: 0,
			calls: 0,
			tokens: null,
			lifetime_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			input_tokens: 0,
			cost_cache_read_usd: 0,
			cost_cache_write_usd: 0,
			cost_input_usd: 0,
			lifetime_cost_usd: 0
		};
		row.runs++;
		row.calls += s.calls;
		if (r.tokens !== null) row.tokens = Math.max(row.tokens ?? r.tokens, r.tokens);
		row.lifetime_tokens += t * s.calls;
		row.cache_read_tokens += t * s.calls - s.rest;
		row.cache_write_tokens += s.wr;
		row.input_tokens += s.rest - s.wr;
		const readUsd = t * s.unitRead - s.restRead;
		row.cost_cache_read_usd += readUsd;
		row.cost_cache_write_usd += s.wrUsd;
		row.cost_input_usd += s.restUsd - s.wrUsd;
		row.lifetime_cost_usd += readUsd + s.restUsd;
		out.set(r.blockHash, row);
	}
	return out;
}
/** The Session's Calls and runs as the store keeps them, for `lifetimes`. */
const PRICED_CALLS = `SELECT lane, idx, cache_boundary_position, cache_boundary_offset, cache_read_tokens,
  cache_write_tokens, unit_read_usd, unit_rest_usd FROM calls WHERE log = ? AND session_id = ?`;
const PRICED_RUNS = `SELECT lane, first_call, last_call, position, tokens, block_hash FROM call_blocks
  WHERE log = ? AND session_id = ?`;
const num = (v) => v === null || v === void 0 ? null : Number(v);
function pricedCall(r) {
	return {
		lane: String(r.lane),
		idx: Number(r.idx),
		boundary: num(r.cache_boundary_position),
		offset: num(r.cache_boundary_offset),
		cacheRead: num(r.cache_read_tokens),
		cacheWrite: num(r.cache_write_tokens),
		unitRead: num(r.unit_read_usd),
		unitRest: num(r.unit_rest_usd)
	};
}
function pricedRun(r) {
	return {
		lane: String(r.lane),
		firstCall: Number(r.first_call),
		lastCall: num(r.last_call),
		position: Number(r.position),
		tokens: num(r.tokens),
		blockHash: String(r.block_hash)
	};
}
// packages/engine/src/query/output.ts
/** A weight only: characters per token, so text and reasoning with no logged text share one total fairly. */
const CHARS_PER_TOKEN = 3.3;
/**
* Sets each entry's `tokens`, `basis` and `costUsd` from the Call's output. With a reported reasoning part, the
* reasoning Blocks share it and the others the rest; reasoning with no text in the log takes what the text leaves.
* Shares are by characters (basis `estimate`); an only Block takes all, with the Call's basis.
*/
function splitOutput(entries, output) {
	if (entries.length === 0) return;
	const estimate = (e) => e.kind === "reasoning" && e.reasoning !== void 0 && e.reasoning !== "full" ? {
		tokens: 0,
		method: "unknown"
	} : {
		tokens: e.chars / CHARS_PER_TOKEN,
		method: "chars"
	};
	const shares = new Array(entries.length).fill(0);
	const reasoning = output.reasoningTokens;
	const pools = reasoning === void 0 || !entries.some((e) => e.kind === "reasoning") ? [{
		pick: () => true,
		total: output.tokens
	}] : [{
		pick: (e) => e.kind === "reasoning",
		total: Math.min(reasoning, output.tokens)
	}, {
		pick: (e) => e.kind !== "reasoning",
		total: Math.max(0, output.tokens - reasoning)
	}];
	for (const pool of pools) {
		const at = entries.flatMap((e, i) => pool.pick(e) ? [i] : []);
		const got = reconcile(at.map((i) => estimate(entries[i])), pool.total);
		at.forEach((i, k) => {
			shares[i] = got[k] ?? 0;
		});
	}
	entries.forEach((e, i) => {
		e.tokens = shares[i] ?? 0;
		e.basis = entries.length === 1 ? output.basis : "estimate";
		if (output.usd !== void 0) e.costUsd = output.tokens === 0 ? 0 : output.usd * e.tokens / output.tokens;
	});
}
/**
* Marks each Block that is part of an earlier Call's Response with that Call: the latest one before the Block's
* run began (or before `index`) whose Response holds the Block's hash.
*/
function markResponses(blocks, responses, index) {
	const by = /* @__PURE__ */ new Map();
	for (const r of responses) for (const b of r.response.blocks) by.set(b.hash, [...by.get(b.hash) ?? [], r.index]);
	for (const b of blocks) {
		const calls = b.hash === void 0 ? void 0 : by.get(b.hash);
		if (calls === void 0) continue;
		const before = b.run?.firstCall ?? index;
		const from = Math.max(...calls.filter((c) => c < before));
		if (Number.isFinite(from)) b.fromResponseOf = from;
	}
}
// packages/engine/src/query/preview.ts
/** The text on one line, cut to `max` characters with `…` when longer. */
function previewOf(text, max) {
	const flat = text.replace(/\s+/g, " ").trim();
	const truncated = flat.length > max;
	return {
		preview: truncated ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat,
		chars: text.length,
		truncated
	};
}
// packages/engine/src/query/parts.ts
/**
* Each part with its text's preview and its share of `tokens`, in proportion to its characters (estimates that add
* up to `tokens`). A Block's only part takes the Block's tokens and basis as they are.
*/
function contextParts(text, parts, tokens, basis, previewChars) {
	const shares = tokens === void 0 ? void 0 : reconcile(parts.map((p) => ({
		tokens: p.end - p.start,
		method: "chars"
	})), tokens);
	return parts.map((p, i) => {
		const out = {
			label: p.label,
			source: p.source,
			start: p.start,
			end: p.end,
			...previewOf(text.slice(p.start, p.end), previewChars)
		};
		const share = shares?.[i];
		if (share !== void 0) {
			out.tokens = share;
			const own = parts.length === 1 ? basis : "estimate";
			if (own !== void 0) out.basis = own;
		}
		return out;
	});
}
/** Tokens by category and part label over the context's Blocks, most first (ties by label). */
function partTotals(blocks) {
	const totals = /* @__PURE__ */ new Map();
	for (const b of blocks) for (const p of b.parts ?? []) {
		const key = `${b.category}\u0000${p.label}`;
		const t = totals.get(key) ?? {
			category: b.category,
			label: p.label,
			tokens: 0
		};
		t.tokens += p.tokens ?? 0;
		totals.set(key, t);
	}
	return [...totals.values()].sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}
// packages/engine/src/query/totals.ts
/**
* `WITH RECURSIVE` CTEs ending in `sub` (one row per root with descendants) for the roots `SELECT log, id FROM
* sessions v WHERE <where>`. Join it as `LEFT JOIN sub ON sub.sub_log = v.log AND sub.sub_id = v.id`. `UNION`
* keeps each (root, descendant) once, so a cycle of parent ids ends.
*/
function subtreeSql(where) {
	return `WITH RECURSIVE tree(log, root, id) AS (
  SELECT v.log, v.id, v.id FROM sessions v WHERE ${where}
  UNION SELECT s.log, t.root, s.id FROM tree t JOIN sessions s ON s.log = t.log AND s.parent_id = t.id
),
sub AS (
  SELECT t.log AS sub_log, t.root AS sub_id, count(DISTINCT t.id) AS sub_sessions, count(c.id) AS sub_calls,
    coalesce(sum(c.input_tokens), 0) AS sub_input_tokens,
    coalesce(sum(c.cache_read_tokens), 0) AS sub_cache_read_tokens,
    coalesce(sum(c.cache_write_tokens), 0) AS sub_cache_write_tokens,
    coalesce(sum(c.output_tokens), 0) AS sub_output_tokens,
    coalesce(sum(c.cost_input_usd), 0) AS sub_cost_input_usd,
    coalesce(sum(c.cost_cache_read_usd), 0) AS sub_cost_cache_read_usd,
    coalesce(sum(c.cost_cache_write_usd), 0) AS sub_cost_cache_write_usd,
    coalesce(sum(c.cost_output_usd), 0) AS sub_cost_output_usd,
    coalesce(sum(c.cost_total_usd), 0) AS sub_cost_total_usd,
    count(c.usage_basis) - count(c.cost_total_usd) AS sub_unpriced_calls
  FROM tree t LEFT JOIN calls c ON c.log = t.log AND c.session_id = t.id
  WHERE t.id <> t.root GROUP BY t.log, t.root
)`;
}
/** The join to `sub` for `v_sessions v`. */
const SUB_JOIN = "LEFT JOIN sub ON sub.sub_log = v.log AND sub.sub_id = v.id";
/** The session list's cost order: with the subagents. */
const TOTAL_COST = "(cost_total_usd + coalesce(sub_cost_total_usd, 0))";
/** A row's `sub_*` columns as the subagents' total (zero when it has none). */
function subagentsOf(r) {
	const n = (v) => Number(v ?? 0);
	return {
		sessions: n(r.sub_sessions),
		calls: n(r.sub_calls),
		tokens: {
			input: n(r.sub_input_tokens),
			cacheRead: n(r.sub_cache_read_tokens),
			cacheWrite: n(r.sub_cache_write_tokens),
			output: n(r.sub_output_tokens)
		},
		cost: {
			inputUsd: n(r.sub_cost_input_usd),
			cacheReadUsd: n(r.sub_cost_cache_read_usd),
			cacheWriteUsd: n(r.sub_cost_cache_write_usd),
			outputUsd: n(r.sub_cost_output_usd),
			totalUsd: n(r.sub_cost_total_usd)
		},
		unpricedCalls: n(r.sub_unpriced_calls)
	};
}
/** Two totals added, part by part. */
function add(a, b) {
	return {
		sessions: a.sessions + b.sessions,
		calls: a.calls + b.calls,
		tokens: {
			input: a.tokens.input + b.tokens.input,
			cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
			cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
			output: a.tokens.output + b.tokens.output
		},
		cost: {
			inputUsd: a.cost.inputUsd + b.cost.inputUsd,
			cacheReadUsd: a.cost.cacheReadUsd + b.cost.cacheReadUsd,
			cacheWriteUsd: a.cost.cacheWriteUsd + b.cost.cacheWriteUsd,
			outputUsd: a.cost.outputUsd + b.cost.outputUsd,
			totalUsd: a.cost.totalUsd + b.cost.totalUsd
		},
		unpricedCalls: a.unpricedCalls + b.unpricedCalls
	};
}
/** `SessionSummary.totals` from the Session's own numbers and its row's `sub_*` columns. */
function totalsOf(own, r) {
	const main = {
		sessions: 1,
		calls: own.calls,
		tokens: { ...own.tokens },
		cost: { ...own.cost },
		unpricedCalls: own.unpricedCalls
	};
	const subagents = subagentsOf(r);
	return {
		main,
		subagents,
		all: add(main, subagents)
	};
}
// packages/engine/src/query/turns.ts
/** Blocks of the model's answer, and the tool results that answer its calls: a prompt after them starts a turn. */
const ANSWER = /* @__PURE__ */ new Set([
	"assistant",
	"reasoning",
	"tool-call",
	"tool-result"
]);
/**
* Marks each message Block with its turn and gives the turns in order. A turn starts with the lead-in of a prompt
* (a `user` Block after an answer): the Blocks after the last answer. Before the first answer all is the first
* turn; when the model answered before any prompt, that part is a turn with no prompt.
*/
function markTurns(blocks) {
	const messages = blocks.filter((b) => b.section === "messages");
	const starts = [];
	let lead = 0;
	let answered = false;
	let waiting = true;
	messages.forEach((b, i) => {
		if (ANSWER.has(b.kind)) {
			answered = true;
			waiting = true;
			lead = i + 1;
		} else if (b.kind === "user" && waiting) {
			if (starts.length === 0 && answered) starts.push(0);
			starts.push(starts.length === 0 ? 0 : lead);
			waiting = false;
		}
	});
	if (starts.length === 0 && messages.length > 0) starts.push(0);
	return starts.map((from, k) => {
		const own = messages.slice(from, starts[k + 1] ?? messages.length);
		const turn = {
			turn: k + 1,
			start: own[0]?.position ?? 0,
			blocks: own.length,
			tokens: 0,
			cachedTokens: 0
		};
		const firstAnswer = own.findIndex((b) => ANSWER.has(b.kind));
		const prompt = own.slice(0, firstAnswer < 0 ? own.length : firstAnswer).findLast((b) => b.kind === "user");
		if (prompt !== void 0) turn.prompt = {
			position: prompt.position,
			preview: prompt.preview
		};
		for (const b of own) {
			b.turn = turn.turn;
			turn.tokens += b.tokens ?? 0;
			if (b.inCachedPrefix) turn.cachedTokens += b.tokens ?? 0;
		}
		return turn;
	});
}
// packages/engine/src/query/unlogged.ts
/** The timer of the summaries, and the size of the prompt and the answer they add (ms, tokens). */
const TICK_MS = 3e4;
/**
* The summaries of all `traces`: one per tick in the run that has a new row since the previous tick, reading the
* prompt of the latest Call sent from the cache. The real timer waits 30 s after a summary ends, so this is a little high.
*/
function estimateUnlogged(traces) {
	const out = {
		calls: 0,
		cacheReadTokens: 0,
		costUsd: 0,
		unpricedCalls: 0,
		subagents: 0
	};
	for (const t of traces) {
		const calls = [...t.calls].sort((a, b) => a.ts - b.ts);
		const changes = [...t.rows, ...calls.map((c) => c.ts)].sort((a, b) => a - b);
		let n = 0;
		let c = -1;
		let r = 0;
		for (let tick = t.started + TICK_MS; tick <= t.ended; tick += TICK_MS) {
			while (c + 1 < calls.length && (calls[c + 1]?.ts ?? 0) <= tick) c++;
			let changed = false;
			while (r < changes.length && (changes[r] ?? 0) <= tick) {
				changed = true;
				r++;
			}
			const prompt = calls[c]?.promptTokens;
			if (!changed || prompt === void 0) continue;
			n++;
			out.cacheReadTokens += prompt;
			if (t.rates === void 0) out.unpricedCalls++;
			else {
				const { input, cacheRead, output } = t.rates;
				out.costUsd += prompt * cacheRead + 400 * input + 40 * output;
			}
		}
		out.calls += n;
		if (n > 0) out.subagents++;
	}
	return out;
}
/** The descendants of Session `(log, id)` (bound as log, id, log, id) and their Calls with usage, in order. */
const UNLOGGED_SQL = `WITH RECURSIVE tree(id) AS (
  SELECT ?2 UNION SELECT s.id FROM tree t JOIN sessions s ON s.log = ?1 AND s.parent_id = t.id
),
tools AS (
  SELECT k.call_id, max(k.duration_ms) AS tool_ms FROM tree t JOIN tool_calls k ON k.log = ?1 AND k.session_id = t.id
  WHERE t.id <> ?2 GROUP BY k.call_id
)
SELECT s.id AS session_id, s.started, s.ended, c.ts, c.input_tokens, c.cache_read_tokens, c.cache_write_tokens,
  c.output_tokens, c.cost_input_usd, c.cost_cache_read_usd, c.cost_output_usd, c.cost_total_usd, tools.tool_ms
FROM tree t JOIN sessions s ON s.log = ?1 AND s.id = t.id
LEFT JOIN calls c ON c.log = s.log AND c.session_id = s.id AND c.input_tokens IS NOT NULL
LEFT JOIN tools ON tools.call_id = c.id
WHERE t.id <> ?2 ORDER BY s.id, c.idx`;
/**
* The traces of `UNLOGGED_SQL`'s rows. Besides each request, a run changes when it ends and when a response is
* written: just before the next request, by the longest tool use of that response. Rates are the subagent's own
* cost per token; with no priced cache read it has none.
*/
function tracesOf(rows) {
	const bySession = /* @__PURE__ */ new Map();
	for (const r of rows) {
		const list = bySession.get(String(r.session_id)) ?? [];
		list.push(r);
		bySession.set(String(r.session_id), list);
	}
	const traces = [];
	for (const list of bySession.values()) {
		const first = list[0];
		const started = Date.parse(String(first?.started));
		const ended = Date.parse(String(first?.ended));
		if (Number.isNaN(started) || Number.isNaN(ended)) continue;
		const sent = list.filter((r) => r.ts !== null && r.ts !== void 0);
		const calls = sent.map((r) => ({
			ts: Date.parse(String(r.ts)),
			promptTokens: Number(r.input_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens)
		}));
		const rows = [ended];
		sent.forEach((r, i) => {
			const next = calls[i + 1];
			if (next !== void 0 && r.tool_ms !== null) rows.push(next.ts - Number(r.tool_ms));
		});
		const trace = {
			started,
			ended,
			calls,
			rows
		};
		const priced = sent.filter((r) => r.cost_total_usd !== null);
		const sum = (k) => priced.reduce((n, r) => n + Number(r[k] ?? 0), 0);
		const per = (usd, tokens) => sum(tokens) > 0 ? sum(usd) / sum(tokens) : 0;
		if (sum("cache_read_tokens") > 0) trace.rates = {
			input: per("cost_input_usd", "input_tokens"),
			cacheRead: per("cost_cache_read_usd", "cache_read_tokens"),
			output: per("cost_output_usd", "output_tokens")
		};
		traces.push(trace);
	}
	return traces;
}
// packages/engine/src/query/views.ts
/** Any run's open end: larger than every Call index. */
const OPEN = "9223372036854775807";
/** Each split Call of a lane joined with every run that covers it (one row per Block per Call). */
const RUN_CALLS = `call_blocks r JOIN calls c ON c.log = r.log AND c.session_id = r.session_id AND c.lane = r.lane
  AND c.idx BETWEEN r.first_call AND coalesce(r.last_call, ${OPEN})`;
const SESSIONS = `
CREATE TEMP VIEW v_sessions AS
SELECT s.log, s.id, s.parent_id, s.title, s.title_source, s.agent_name, s.harness, s.harness_version, s.project,
  s.cwd, s.started, s.ended, s.request_log, s.changed_seq,
  count(c.id) AS calls,
  group_concat(DISTINCT coalesce(c.canonical_model, c.model)) AS models,
  coalesce(sum(c.input_tokens), 0) AS input_tokens,
  coalesce(sum(c.cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(c.cache_write_tokens), 0) AS cache_write_tokens,
  coalesce(sum(c.output_tokens), 0) AS output_tokens,
  coalesce(sum(c.cost_input_usd), 0) AS cost_input_usd,
  coalesce(sum(c.cost_cache_read_usd), 0) AS cost_cache_read_usd,
  coalesce(sum(c.cost_cache_write_usd), 0) AS cost_cache_write_usd,
  coalesce(sum(c.cost_output_usd), 0) AS cost_output_usd,
  coalesce(sum(c.cost_total_usd), 0) AS cost_total_usd,
  count(c.usage_basis) - count(c.cost_total_usd) AS unpriced_calls,
  coalesce(max(CASE WHEN c.usage_basis = 'exact'
    THEN c.input_tokens + c.cache_read_tokens + c.cache_write_tokens END), 0) AS max_context_tokens,
  CAST(sum(c.cache_read_tokens) AS REAL)
    / nullif(sum(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens), 0) AS cache_hit_rate,
  count(CASE WHEN c.issues <> '[]' THEN 1 END) AS calls_with_issues
FROM sessions s LEFT JOIN calls c ON c.log = s.log AND c.session_id = s.id
GROUP BY s.log, s.id`;
const CALLS = `
CREATE TEMP VIEW v_calls AS
SELECT c.log, c.session_id, c.idx, c.id, c.lane, c.ts, c.model, c.canonical_model,
  c.params ->> '$.effort' AS effort, c.params ->> '$.reasoning.mode' AS reasoning,
  c.params ->> '$.maxTokens' AS max_tokens, c.usage_basis,
  c.input_tokens, c.cache_read_tokens, c.cache_write_tokens, c.output_tokens, c.reasoning_output_tokens,
  c.input_tokens + c.cache_read_tokens + c.cache_write_tokens AS input_total,
  CAST(c.cache_read_tokens AS REAL)
    / nullif(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens, 0) AS cache_hit_rate,
  c.cost_input_usd, c.cost_cache_read_usd, c.cost_cache_write_usd, c.cost_output_usd, c.cost_total_usd,
  c.block_count, c.cache_boundary_tokens, c.cache_boundary_position, c.framing_tokens,
  json_array_length(c.issues) AS issue_count,
  (SELECT group_concat(i.value ->> '$.kind', ',') FROM json_each(c.issues) i) AS issue_kinds,
  c.turn_duration_ms
FROM calls c`;
const CONTEXT = `
CREATE TEMP VIEW v_context AS
SELECT r.log, r.session_id, r.lane, r.first_call,
  coalesce(r.last_call, (SELECT max(l.idx) FROM calls l
    WHERE l.log = r.log AND l.session_id = r.session_id AND l.lane = r.lane)) AS last_call,
  r.last_call IS NULL AS open, r.position, r.section, r.message, r.block_hash,
  b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment, r.tokens, r.basis, r.grp,
  (SELECT count(*) FROM calls l WHERE l.log = r.log AND l.session_id = r.session_id AND l.lane = r.lane
    AND l.idx BETWEEN r.first_call AND coalesce(r.last_call, ${OPEN})) AS calls
FROM call_blocks r JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash`;
/**
* The lifetime cost of each Block of a log: a run's tokens count for each Call of its lane in its range. Per Call,
* a Block wholly inside the Cached prefix is priced at the Call's price per cache-read token; the Block at the
* boundary has the rest of the cache read (`cache_read_tokens` less the store's `cache_boundary_offset`); the
* rest of a Block at the price of the cache write, or of plain input when the Call wrote no cache. This is core's
* `blockCosts` for every Call whose input tokens are its framing tokens. A run is priced as read in all its
* Calls, then corrected for the Calls where it lies at or after the boundary. `session`: only one Session's runs
* are read; the query then takes (log, session id).
*/
function lifetimeSql(session = false) {
	const runs = session ? "WHERE r.log = ? AND r.session_id = ?" : "";
	const after = "r.position >= c.cache_boundary_position";
	const rest = `(CASE WHEN r.position > c.cache_boundary_position THEN r.tokens
    ELSE r.tokens - min(r.tokens, max(0, c.cache_read_tokens - c.cache_boundary_offset)) END)`;
	return `
WITH per_run AS (
  SELECT r.log, r.block_hash, r.tokens, count(*) AS calls, sum(c.unit_read_usd) AS unit_read,
    sum(CASE WHEN ${after} THEN ${rest} END) AS rest,
    sum(CASE WHEN ${after} THEN ${rest} * c.unit_read_usd END) AS rest_read_usd,
    sum(CASE WHEN ${after} THEN ${rest} * c.unit_rest_usd END) AS rest_usd,
    sum(CASE WHEN ${after} AND c.cache_write_tokens > 0 THEN ${rest} END) AS wr,
    sum(CASE WHEN ${after} AND c.cache_write_tokens > 0 THEN ${rest} * c.unit_rest_usd END) AS wr_usd
  FROM ${RUN_CALLS} ${runs}
  GROUP BY r.log, r.session_id, r.lane, r.first_call, r.position
),
priced AS (
  SELECT log, block_hash, tokens, calls, tokens * calls AS lifetime_tokens,
    tokens * calls - coalesce(rest, 0) AS rd, coalesce(wr, 0) AS wr, coalesce(rest, 0) - coalesce(wr, 0) AS inp,
    tokens * coalesce(unit_read, 0) - coalesce(rest_read_usd, 0) AS rd_usd, coalesce(wr_usd, 0) AS wr_usd,
    coalesce(rest_usd, 0) - coalesce(wr_usd, 0) AS inp_usd
  FROM per_run
)
SELECT p.log, p.block_hash, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment,
  count(*) AS runs, sum(p.calls) AS calls, max(p.tokens) AS tokens,
  coalesce(sum(p.lifetime_tokens), 0) AS lifetime_tokens,
  coalesce(sum(p.rd), 0) AS cache_read_tokens,
  sum(p.wr) AS cache_write_tokens,
  sum(p.inp) AS input_tokens,
  coalesce(sum(p.rd_usd), 0) AS cost_cache_read_usd,
  sum(p.wr_usd) AS cost_cache_write_usd,
  sum(p.inp_usd) AS cost_input_usd,
  coalesce(sum(p.rd_usd), 0) + sum(p.wr_usd) + sum(p.inp_usd) AS lifetime_cost_usd
FROM priced p JOIN log_blocks b ON b.log = p.log AND b.hash = p.block_hash
GROUP BY p.log, p.block_hash`;
}
/** No lifetime rows: the caller adds them (`lifetimes.ts`). */
const NO_LIFETIME = `(SELECT NULL AS log, NULL AS block_hash, NULL AS tokens, NULL AS calls, NULL AS runs,
  NULL AS lifetime_tokens, NULL AS cache_read_tokens, NULL AS cache_write_tokens, NULL AS input_tokens,
  NULL AS cost_cache_read_usd, NULL AS cost_cache_write_usd, NULL AS cost_input_usd, NULL AS lifetime_cost_usd
  WHERE 0)`;
/**
* Each tool use with its result Block's lifetime cost (null `lifetime`: none, the caller adds them). `lifetime`: the lifetime rows to join (the view, or a
* Session's own); `where` filters the tool uses (`t`). `cut`: the input summary is the first 200 characters; false:
* the whole input, for a caller that makes its own preview (`previewOf`).
*/
function toolOutputsSql(lifetime, where = "", cut = true) {
	const input = "coalesce(t.input, (SELECT json_extract(k.content, '$.input') FROM blocks k WHERE k.hash = t.block_hash))";
	return `
SELECT t.log, t.session_id, t.id AS tool_use_id, t.name AS tool, t.mcp_server, t.file_path, t.skill, t.is_error,
  c.idx AS call_idx,
  ${cut ? `substr(${input}, 1, 200)` : input} AS input_summary,
  t.result_block_hash, t.block_hash AS call_block_hash, l.tokens, l.calls, l.runs,
  (SELECT min(r.first_call) FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
    AND r.session_id = t.session_id) AS first_call,
  (SELECT max(coalesce(r.last_call, (SELECT max(m.idx) FROM calls m
      WHERE m.log = r.log AND m.session_id = r.session_id AND m.lane = r.lane)))
    FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
    AND r.session_id = t.session_id) AS last_call,
  l.lifetime_tokens, l.cache_read_tokens, l.cache_write_tokens, l.input_tokens,
  l.cost_cache_read_usd, l.cost_cache_write_usd, l.cost_input_usd, l.lifetime_cost_usd
FROM tool_calls t
LEFT JOIN calls c ON c.log = t.log AND c.id = t.call_id
LEFT JOIN ${lifetime ?? NO_LIFETIME} l ON l.log = t.log AND l.block_hash = t.result_block_hash
${where}`;
}
const LIFETIME = `CREATE TEMP VIEW v_block_lifetime_cost AS ${lifetimeSql()}`;
const TOOL_OUTPUTS = `CREATE TEMP VIEW v_tool_outputs AS ${toolOutputsSql("v_block_lifetime_cost")}`;
/**
* Calls whose cache read dropped against the previous Call: of their lane, or the previous Call in time when that one
* ran on another model (the cache belongs to a model). The reason, first that fits: a compaction between them, a
* model switch, a pause longer than the cache's time to live (5 minutes, or 1 hour when the previous Call wrote
* its cache for an hour), else a change early in the request. `session`: only one Session's Calls are read; the
* query then takes (log, session id).
*/
function cacheBreaksSql(session = false) {
	return `
WITH ordered AS (
  SELECT c.log, c.session_id, c.lane, c.idx, c.id AS call_id, c.ts, c.model, c.cache_read_tokens,
    c.cache_write_tokens, c.input_tokens, c.cache_boundary_position, c.block_count,
    lag(c.idx) OVER lane_w AS l_idx, lag(c.ts) OVER lane_w AS l_ts, lag(c.model) OVER lane_w AS l_model,
    lag(c.cache_read_tokens) OVER lane_w AS l_cr, lag(c.cache_write_1h_tokens) OVER lane_w AS l_w1h,
    lag(c.idx) OVER time_w AS t_idx, lag(c.ts) OVER time_w AS t_ts, lag(c.model) OVER time_w AS t_model,
    lag(c.cache_read_tokens) OVER time_w AS t_cr, lag(c.cache_write_1h_tokens) OVER time_w AS t_w1h
  FROM calls c WHERE c.usage_basis IS NOT NULL ${session ? "AND c.log = ? AND c.session_id = ?" : ""}
  WINDOW lane_w AS (PARTITION BY c.log, c.session_id, c.lane ORDER BY c.idx),
    time_w AS (PARTITION BY c.log, c.session_id ORDER BY c.idx)
),
paired AS (
  SELECT *, coalesce(t_model <> model AND (l_idx IS NULL OR t_idx > l_idx), 0) AS switched FROM ordered
),
prev AS (
  SELECT log, session_id, lane, idx, call_id, ts, model, cache_read_tokens, cache_write_tokens, input_tokens,
    cache_boundary_position, block_count,
    CASE WHEN switched THEN t_idx ELSE l_idx END AS prev_idx,
    CASE WHEN switched THEN t_ts ELSE l_ts END AS prev_ts,
    CASE WHEN switched THEN t_model ELSE l_model END AS prev_model,
    CASE WHEN switched THEN t_cr ELSE l_cr END AS prev_cache_read_tokens,
    CASE WHEN switched THEN t_w1h ELSE l_w1h END AS prev_w1h
  FROM paired
)
SELECT x.log, x.session_id, x.lane, x.idx, x.call_id, x.ts, x.model, x.prev_idx, x.prev_ts, x.prev_model,
  CAST(round((julianday(x.ts) - julianday(x.prev_ts)) * 86400) AS INTEGER) AS gap_seconds,
  x.prev_cache_read_tokens, x.cache_read_tokens, x.prev_cache_read_tokens - x.cache_read_tokens AS drop_tokens,
  x.cache_write_tokens, x.input_tokens, x.cache_boundary_position AS break_position, x.block_count,
  b.block_hash AS break_block_hash, k.kind AS break_kind, k.tool AS break_tool,
  CASE
    WHEN k.kind = 'summary' OR EXISTS (SELECT 1 FROM compactions m WHERE m.log = x.log AND m.session_id = x.session_id
      AND m.ts > x.prev_ts AND m.ts <= x.ts) THEN 'compaction'
    WHEN x.prev_model <> x.model THEN 'model-switch'
    WHEN (julianday(x.ts) - julianday(x.prev_ts)) * 86400 > CASE WHEN x.prev_w1h > 0 THEN 3600 ELSE 300 END
      THEN 'ttl'
    ELSE 'prefix-change'
  END AS reason
FROM prev x
LEFT JOIN call_blocks b ON b.log = x.log AND b.session_id = x.session_id AND b.lane = x.lane
  AND b.first_call <= x.idx AND coalesce(b.last_call, ${OPEN}) >= x.idx AND b.position = x.cache_boundary_position
LEFT JOIN log_blocks k ON k.log = b.log AND k.hash = b.block_hash
WHERE x.cache_read_tokens < x.prev_cache_read_tokens`;
}
const CACHE_BREAKS = `CREATE TEMP VIEW v_cache_breaks AS ${cacheBreaksSql()}`;
/** Make the views on this connection (TEMP: they belong to it, and need no write to the store). */
function installViews(db) {
	for (const sql of [
		SESSIONS,
		CALLS,
		CONTEXT,
		LIFETIME,
		TOOL_OUTPUTS,
		CACHE_BREAKS
	]) db.exec(sql);
}
// packages/engine/src/query/query.ts
const LIFETIME_SORTS$1 = {
	cost: "lifetime_cost_usd",
	tokens: "lifetime_tokens",
	calls: "calls"
};
/** One Session's tool uses, without lifetimes: `lifetimes.ts` gives those. */
const SESSION_TOOLS = toolOutputsSql(null, "WHERE t.log = ? AND t.session_id = ?", false);
const SESSION_BREAKS = cacheBreaksSql(true);
/** One Block of a log, with its kind, source and content. */
const BLOCK_OF_LOG = `SELECT b.*, k.content FROM log_blocks b JOIN blocks k ON k.hash = b.hash
  WHERE b.log = ? AND b.hash = ?`;
const SORTS$1 = {
	ended: "coalesce(ended, started)",
	started: "started",
	cost: TOTAL_COST,
	calls: "calls"
};
function createQuery(options) {
	const { db, codec } = options;
	if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'view' AND name = 'v_sessions'").get() === void 0) installViews(db);
	const now = options.now ?? Date.now;
	const liveWindowMs = options.liveWindowMs ?? 3e5;
	const previewChars = options.previewChars ?? 240;
	const meta = { apiVersion: 1 };
	const cache = /* @__PURE__ */ new Map();
	const q = (sql) => {
		let s = cache.get(sql);
		if (s === void 0) {
			s = db.prepare(sql);
			cache.set(sql, s);
		}
		return s;
	};
	/** Each Block's lifetime in one Session's Calls (`lifetimes.ts`: linear in its Calls and runs). */
	const sessionLifetimes = (key) => lifetimes(q(PRICED_CALLS).all(key.log, key.id).map(pricedCall), q(PRICED_RUNS).all(key.log, key.id).map(pricedRun));
	const media = (hash) => {
		const r = q("SELECT bytes FROM media WHERE hash = ?").get(hash);
		if (!(r?.bytes instanceof Uint8Array)) throw new Error(`the store has no media ${hash}`);
		return r.bytes;
	};
	/** The display text of stored content; media are read only for content that names them. */
	const textOf = (stored) => {
		const raw = String(stored);
		const content = json$1(raw);
		return codec.text(raw.includes("\"$media\"") ? codec.unpackContent(content, media) : content);
	};
	const hasSession = (key) => q("SELECT 1 FROM sessions WHERE log = ? AND id = ?").get(key.log, key.id) !== void 0;
	const issuesOf = (logs) => {
		const out = /* @__PURE__ */ new Map();
		if (logs.length === 0) return out;
		const rows = db.prepare(`SELECT c.log, c.session_id, i.value ->> '$.kind' AS kind, count(*) AS n
         FROM calls c, json_each(c.issues) i WHERE c.issues <> '[]' AND c.log IN (${logs.map(() => "?").join(",")})
         GROUP BY c.log, c.session_id, kind`).all(...logs);
		for (const r of rows) {
			const k = `${r.log}\0${r.session_id}`;
			const entry = out.get(k) ?? {};
			entry[String(r.kind)] = Number(r.n);
			out.set(k, entry);
		}
		return out;
	};
	const summary = (r, issues) => {
		const own = {
			log: Number(r.log),
			id: String(r.id),
			harness: String(r.harness),
			models: r.models === null ? [] : String(r.models).split(",").sort(),
			calls: Number(r.calls),
			tokens: {
				input: Number(r.input_tokens),
				cacheRead: Number(r.cache_read_tokens),
				cacheWrite: Number(r.cache_write_tokens),
				output: Number(r.output_tokens)
			},
			cost: {
				inputUsd: Number(r.cost_input_usd),
				cacheReadUsd: Number(r.cost_cache_read_usd),
				cacheWriteUsd: Number(r.cost_cache_write_usd),
				outputUsd: Number(r.cost_output_usd),
				totalUsd: Number(r.cost_total_usd)
			},
			unpricedCalls: Number(r.unpriced_calls),
			maxContextTokens: Number(r.max_context_tokens),
			requestLog: String(r.request_log),
			issues: issues.get(`${r.log}\0${r.id}`) ?? {},
			live: r.ended !== null && now() - Date.parse(String(r.ended)) <= liveWindowMs
		};
		const s = {
			...own,
			totals: totalsOf(own, r)
		};
		const opt = (field, value) => {
			if (value !== null && value !== void 0) s[field] = String(value);
		};
		opt("parentId", r.parent_id);
		opt("title", r.title);
		opt("titleSource", r.title_source);
		opt("agentName", r.agent_name);
		opt("harnessVersion", r.harness_version);
		opt("project", r.project);
		opt("cwd", r.cwd);
		opt("started", r.started);
		opt("ended", r.ended);
		if (r.cache_hit_rate !== null) s.cacheHitRate = Number(r.cache_hit_rate);
		return s;
	};
	const projectFilter = (names, params) => {
		const one = () => "(project = ? OR project LIKE ? ESCAPE '!' OR project LIKE ? ESCAPE '!')";
		for (const n of names) {
			const e = n.replace(/[!%_]/g, "!$&");
			params.push(n, `%/${e}`, `%\\${e}`);
		}
		return names.length === 0 ? "0" : `(${names.map(one).join(" OR ")})`;
	};
	const subagentsOf = (keys) => {
		if (keys.length === 0) return [];
		const logs = [...new Set(keys.map((k) => k.log))];
		const rows = db.prepare(`${subtreeSql(`v.parent_id IS NOT NULL AND v.log IN (${logs.map(() => "?").join(",")})`)}
         SELECT * FROM v_sessions v ${SUB_JOIN} WHERE parent_id IS NOT NULL AND log IN (${logs.map(() => "?").join(",")})
         ORDER BY started, id`).all(...logs, ...logs);
		const issues = issuesOf(logs);
		return rows.map((r) => summary(r, issues));
	};
	/** Nest each subagent under its parent, at any depth. */
	const nest = (mains, children) => {
		const byKey = /* @__PURE__ */ new Map();
		for (const s of [...mains, ...children]) byKey.set(`${s.log}\0${s.id}`, s);
		for (const child of children) {
			const parent = byKey.get(`${child.log}\0${child.parentId ?? ""}`);
			if (parent === void 0) continue;
			parent.subagents ??= [];
			parent.subagents.push(child);
		}
	};
	const callRow = (key, index) => q("SELECT * FROM calls WHERE log = ? AND session_id = ? AND idx = ?").get(key.log, key.id, index);
	const toolUsesOf = (key) => {
		const out = /* @__PURE__ */ new Map();
		for (const r of q("SELECT id, call_id, name FROM tool_calls WHERE log = ? AND session_id = ? ORDER BY id").all(key.log, key.id)) {
			const list = out.get(String(r.call_id)) ?? [];
			list.push({
				id: String(r.id),
				name: String(r.name)
			});
			out.set(String(r.call_id), list);
		}
		return out;
	};
	const callSummary = (r, tools) => {
		const c = call$1(r);
		const s = {
			id: c.id,
			index: c.index,
			lane: c.lane,
			ts: c.ts,
			model: c.model,
			params: stableParams(c.params),
			cacheBreakpoints: c.cacheBreakpoints,
			framingTokens: c.framingTokens,
			issues: c.issues,
			toolCalls: tools
		};
		if (c.usage !== void 0) s.usage = c.usage;
		if (c.cost !== void 0) s.cost = c.cost;
		if (c.cacheBoundary !== void 0) s.cacheBoundary = c.cacheBoundary;
		if (c.blockCount !== void 0) s.blockCount = c.blockCount;
		if (c.turnDurationMs !== void 0) s.turnDurationMs = c.turnDurationMs;
		return s;
	};
	/** The Blocks of one Call: one range lookup on the runs' key, with each Block's kind, source and content. */
	const RUNS_AT = `SELECT r.*, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment, b.parts, k.content
    FROM call_blocks r
    JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
    JOIN blocks k ON k.hash = r.block_hash
    WHERE r.log = ? AND r.session_id = ? AND r.lane = ? AND r.first_call <= ?
      AND (r.last_call IS NULL OR r.last_call >= ?)
    ORDER BY r.position`;
	const responseAt = (key, index) => {
		const row = hasSession(key) ? callRow(key, index) : void 0;
		if (row === void 0) return void 0;
		const tools = toolUsesOf(key).get(String(row.id)) ?? [];
		const call = callSummary(row, tools);
		const response = call$1(row).response;
		const blocks = (response?.blocks ?? []).flatMap((b) => {
			const r = q(BLOCK_OF_LOG).get(key.log, b.hash);
			if (r === void 0) throw new Error(`the response of call ${index} names Block ${b.hash}, not in the store`);
			const source = sourceOf(r);
			const entry = {
				hash: b.hash,
				kind: b.kind,
				category: categoryOf(b.kind, "messages", source),
				source,
				...previewOf(textOf(r.content), previewChars)
			};
			if (b.reasoning !== void 0) entry.reasoning = b.reasoning;
			const tool = b.toolUseId === void 0 ? void 0 : tools.find((t) => t.id === b.toolUseId);
			if (tool !== void 0) entry.toolCall = tool;
			return [entry];
		});
		const out = {
			...meta,
			session: {
				log: key.log,
				id: key.id
			},
			call,
			answered: blocks.length > 0,
			blocks
		};
		if (response?.stopReason !== void 0) out.stopReason = response.stopReason;
		if (call.usage !== void 0) out.outputTokens = call.usage.outputTokens;
		if (call.usage?.reasoningOutputTokens !== void 0) out.reasoningOutputTokens = call.usage.reasoningOutputTokens;
		if (call.cost !== void 0) out.outputUsd = call.cost.outputUsd;
		if (call.usage !== void 0) splitOutput(blocks, {
			tokens: call.usage.outputTokens,
			basis: call.usage.basis,
			...out.reasoningOutputTokens === void 0 ? {} : { reasoningTokens: out.reasoningOutputTokens },
			...out.outputUsd === void 0 ? {} : { usd: out.outputUsd }
		});
		return out;
	};
	const context = (key, index) => {
		const row = hasSession(key) ? callRow(key, index) : void 0;
		if (row === void 0) return void 0;
		const call = callSummary(row, toolUsesOf(key).get(String(row.id)) ?? []);
		const rebuilt = call.blockCount !== void 0;
		const runs = rebuilt ? q(RUNS_AT).all(key.log, key.id, call.lane, index, index) : [];
		const boundary = call.cacheBoundary?.position ?? 0;
		const blocks = runs.map((r) => {
			const run$1 = run(r);
			const source = sourceOf(r);
			const text = textOf(r.content);
			const shown = previewOf(text, previewChars);
			const b = {
				position: run$1.position,
				section: run$1.section,
				hash: run$1.blockHash,
				kind: String(r.kind),
				category: categoryOf(String(r.kind), run$1.section, source),
				source,
				inCachedPrefix: run$1.position < boundary,
				...shown,
				run: run$1.lastCall === void 0 ? { firstCall: run$1.firstCall } : {
					firstCall: run$1.firstCall,
					lastCall: run$1.lastCall
				}
			};
			if (isDeferred(b.kind, b.section)) b.deferred = true;
			if (run$1.message !== void 0) b.message = run$1.message;
			if (run$1.tokens !== void 0) b.tokens = run$1.tokens;
			if (run$1.basis !== void 0) b.basis = run$1.basis;
			if (run$1.group !== void 0) b.group = run$1.group;
			if (r.parts !== null && r.parts !== void 0) b.parts = contextParts(text, JSON.parse(String(r.parts)), run$1.tokens, run$1.basis, previewChars);
			return b;
		});
		if (rebuilt) markResponses(blocks, q("SELECT idx, response FROM calls WHERE log = ? AND session_id = ? AND idx < ? AND response IS NOT NULL").all(key.log, key.id, index).map((r) => ({
			index: Number(r.idx),
			response: JSON.parse(String(r.response))
		})), index);
		if (rebuilt) {
			const framing = {
				position: blocks.length,
				section: "framing",
				kind: "framing",
				category: "other",
				source: {},
				basis: "framing",
				inCachedPrefix: false,
				preview: "",
				chars: 0,
				truncated: false
			};
			if (call.usage !== void 0) framing.tokens = call.framingTokens;
			blocks.push(framing);
		}
		if (call.usage !== void 0 && call.cost !== void 0 && rebuilt) {
			const costs = blockCosts(blocks.map((b) => b.tokens ?? 0), call.usage, call.cost);
			blocks.forEach((b, i) => {
				b.costUsd = costs[i] ?? 0;
			});
		}
		const sections = {
			tools: 0,
			system: 0,
			messages: 0,
			framing: 0
		};
		const categories = emptyCategories();
		for (const b of blocks) {
			sections[b.section] += b.tokens ?? 0;
			categories[b.category] += b.tokens ?? 0;
		}
		const u = call.usage;
		return {
			...meta,
			session: {
				log: key.log,
				id: key.id
			},
			lane: call.lane,
			call,
			rebuilt,
			blocks,
			sections,
			categories,
			partTotals: partTotals(blocks),
			turns: rebuilt ? markTurns(blocks) : [],
			totalTokens: u === void 0 ? blocks.reduce((n, b) => n + (b.tokens ?? 0), 0) : u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
		};
	};
	/**
	* The Call to compare Call `index` with: the previous Call of its lane, or the previous Call in time when that one
	* ran on another model (the cache is per model). `modelSwitch` says which.
	*/
	const previousOf = (key, call) => {
		const inLane = q("SELECT max(idx) AS idx FROM calls WHERE log = ? AND session_id = ? AND lane = ? AND idx < ?").get(key.log, key.id, call.lane, call.index)?.idx;
		const before = q("SELECT idx, model FROM calls WHERE log = ? AND session_id = ? AND idx < ? AND usage_basis IS NOT NULL ORDER BY idx DESC LIMIT 1").get(key.log, key.id, call.index);
		const lane = inLane === null || inLane === void 0 ? void 0 : Number(inLane);
		if (before !== void 0 && before.model !== call.model && (lane === void 0 || Number(before.idx) > lane)) return {
			index: Number(before.idx),
			modelSwitch: true
		};
		return lane === void 0 ? void 0 : {
			index: lane,
			modelSwitch: false
		};
	};
	/**
	* The timeline: the Session's runs grouped by lane, Call range, section and group (one read), then summed per Call
	* by a sweep over each lane's Calls: a run adds its tokens at its first Call and takes them off after its last.
	*/
	const timeline = (key) => {
		const groups = q(`SELECT r.lane, r.first_call, r.last_call, r.section, b.kind, b.tool IS NOT NULL AS by_tool,
         sum(r.tokens) AS tokens
       FROM call_blocks r JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
       WHERE r.log = ? AND r.session_id = ? GROUP BY r.lane, r.first_call, r.last_call, r.section, b.kind, by_tool`).all(key.log, key.id);
		const starts = /* @__PURE__ */ new Map();
		const ends = /* @__PURE__ */ new Map();
		for (const g of groups) {
			const section = String(g.section);
			const change = {
				section,
				category: categoryOf(String(g.kind), section, Number(g.by_tool) === 1 ? { tool: "" } : {}),
				tokens: Number(g.tokens ?? 0)
			};
			const lane = String(g.lane);
			const s = starts.get(lane) ?? [];
			const e = ends.get(lane) ?? [];
			starts.set(lane, s);
			ends.set(lane, e);
			s.push({
				...change,
				at: Number(g.first_call)
			});
			if (g.last_call !== null) e.push({
				...change,
				at: Number(g.last_call)
			});
		}
		for (const list of [...starts.values(), ...ends.values()]) list.sort((a, b) => a.at - b.at);
		const marks = /* @__PURE__ */ new Map();
		for (const c of compactionsOf(key, false)) {
			if (c.summaryCallIndex !== void 0) marks.set(c.summaryCallIndex, "summary");
			if (c.afterCallIndex !== void 0) marks.set(c.afterCallIndex, "after");
		}
		const lanes = /* @__PURE__ */ new Map();
		const zero = () => ({
			tools: 0,
			system: 0,
			messages: 0,
			framing: 0
		});
		return q("SELECT * FROM calls WHERE log = ? AND session_id = ? ORDER BY idx").all(key.log, key.id).map((row) => {
			const c = call$1(row);
			const t = lanes.get(c.lane) ?? {
				sections: zero(),
				categories: emptyCategories(),
				start: 0,
				end: 0
			};
			lanes.set(c.lane, t);
			const add = (x, sign) => {
				if (x === void 0) return;
				t.sections[x.section] += sign * x.tokens;
				t.categories[x.category] += sign * x.tokens;
			};
			const ending = ends.get(c.lane) ?? [];
			while (t.end < ending.length && (ending[t.end]?.at ?? 0) < c.index) add(ending[t.end++], -1);
			const starting = starts.get(c.lane) ?? [];
			while (t.start < starting.length && (starting[t.start]?.at ?? 0) <= c.index) add(starting[t.start++], 1);
			const rebuilt = c.blockCount !== void 0;
			const framing = rebuilt && c.usage !== void 0 ? c.framingTokens : 0;
			const item = {
				index: c.index,
				lane: c.lane,
				ts: c.ts,
				model: c.model,
				rebuilt,
				sections: rebuilt ? {
					...t.sections,
					framing
				} : zero(),
				categories: rebuilt ? {
					...t.categories,
					other: t.categories.other + framing
				} : emptyCategories(),
				issues: c.issues.map((i) => i.kind)
			};
			if (c.usage !== void 0) item.usage = c.usage;
			if (c.cost !== void 0) {
				const { inputUsd, cacheReadUsd, cacheWriteUsd, outputUsd, totalUsd } = c.cost;
				item.cost = {
					inputUsd,
					cacheReadUsd,
					cacheWriteUsd,
					outputUsd,
					totalUsd
				};
			}
			if (c.cacheBoundary !== void 0) item.cacheBoundary = c.cacheBoundary;
			const mark = marks.get(c.index);
			if (mark !== void 0) item.compaction = mark;
			return item;
		});
	};
	const group = (blocks) => {
		const categories = emptyCategories();
		let tokens = 0;
		for (const b of blocks) {
			tokens += b.tokens ?? 0;
			categories[b.category] += b.tokens ?? 0;
		}
		return {
			blocks: blocks.length,
			tokens,
			categories
		};
	};
	const indexOf = (key, callId) => {
		if (callId === void 0) return void 0;
		const r = q("SELECT idx FROM calls WHERE log = ? AND id = ?").get(key.log, callId);
		return r === void 0 ? void 0 : Number(r.idx);
	};
	/** The Session's compactions; `contexts`: also what was removed and kept, from the contexts before and after. */
	const compactionsOf = (key, contexts) => {
		if (!hasSession(key)) return [];
		return q("SELECT * FROM compactions WHERE log = ? AND session_id = ? ORDER BY ts, id").all(key.log, key.id).map((r) => {
			const c = compaction(r);
			const detail = { ...c };
			const before = indexOf(key, c.beforeCallId);
			const summaryIndex = indexOf(key, c.summaryCallId);
			if (before !== void 0) detail.beforeCallIndex = before;
			if (summaryIndex !== void 0) detail.summaryCallIndex = summaryIndex;
			const lane = before === void 0 ? void 0 : callRow(key, before)?.lane;
			const after = lane === void 0 || before === void 0 ? void 0 : q(`SELECT min(idx) AS idx FROM calls WHERE log = ? AND session_id = ? AND lane = ? AND idx > ?
               AND block_count IS NOT NULL`).get(key.log, key.id, String(lane), Math.max(before, summaryIndex ?? before))?.idx;
			if (after !== void 0 && after !== null) {
				detail.afterCallIndex = Number(after);
				if (!contexts) return detail;
				const was = before === void 0 ? void 0 : context(key, before);
				const now = context(key, Number(after));
				if (was !== void 0 && now !== void 0) {
					const real = (b) => b.hash !== void 0;
					const kept = new Set(now.blocks.filter(real).map((b) => b.hash));
					detail.removed = group(was.blocks.filter((b) => real(b) && !kept.has(b.hash)));
					detail.kept = group(was.blocks.filter((b) => real(b) && kept.has(b.hash)));
					detail.summaryTokens = now.blocks.filter((b) => b.kind === "summary").reduce((n, b) => n + (b.tokens ?? 0), 0);
				}
			}
			return detail;
		});
	};
	const changeCursor = () => Number(q("SELECT seq FROM change_cursor").get()?.seq ?? 0);
	return {
		changeCursor,
		hasSession,
		listProjects() {
			const items = q(`SELECT project, count(*) AS n, max(coalesce(ended, started)) AS last FROM sessions
         WHERE parent_id IS NULL AND project IS NOT NULL GROUP BY project ORDER BY last IS NULL, last DESC, project`).all().map((r) => {
				const p = {
					project: String(r.project),
					sessions: Number(r.n)
				};
				if (r.last !== null && r.last !== void 0) p.ended = String(r.last);
				return p;
			});
			return {
				...meta,
				items
			};
		},
		listSessions(filter = {}) {
			const cursor = changeCursor();
			const params = [];
			const where = ["(parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.log = v.log AND p.id = v.parent_id))"];
			if (filter.project !== void 0) where.push(projectFilter([filter.project], params));
			if (filter.changedSince !== void 0) {
				where.push(`(changed_seq > ? OR EXISTS (SELECT 1 FROM sessions a WHERE a.log = v.log AND a.parent_id = v.id
          AND a.changed_seq > ?))`);
				params.push(filter.changedSince, filter.changedSince);
			}
			if (filter.search !== void 0 && filter.search !== "") {
				where.push("(instr(lower(coalesce(title, '')), lower(?)) > 0 OR instr(id, ?) > 0)");
				params.push(filter.search, filter.search);
			}
			const order = filter.order === "asc" ? "ASC" : "DESC";
			const sort = SORTS$1[filter.sort ?? "ended"];
			const limit = Math.max(0, filter.limit ?? 50);
			const offset = Math.max(0, filter.offset ?? 0);
			const clause = where.join(" AND ");
			const rows = db.prepare(`${subtreeSql(clause)}
           SELECT *, count(*) OVER () AS total_rows FROM v_sessions v ${SUB_JOIN} WHERE ${clause}
           ORDER BY ${sort} IS NULL, ${sort} ${order}, log, id LIMIT ? OFFSET ?`).all(...params, ...params, limit, offset);
			const total = rows[0] !== void 0 ? Number(rows[0].total_rows) : Number(db.prepare(`SELECT count(*) AS n FROM v_sessions v WHERE ${clause}`).get(...params)?.n);
			const issues = issuesOf([...new Set(rows.map((r) => Number(r.log)))]);
			const items = rows.map((r) => summary(r, issues));
			nest(items, subagentsOf(items));
			return {
				...meta,
				total,
				offset,
				items,
				cursor
			};
		},
		findSessions(id) {
			return q(`SELECT log, id FROM sessions WHERE id = ? OR substr(id, 1, length(?)) = ?
         ORDER BY id = ? DESC, coalesce(ended, started) DESC, log DESC`).all(id, id, id, id).map((r) => ({
				log: Number(r.log),
				id: String(r.id)
			}));
		},
		getSession(key) {
			const row = q(`${subtreeSql("v.log = ? AND v.id = ?")} SELECT * FROM v_sessions v ${SUB_JOIN}
        WHERE log = ? AND id = ?`).get(key.log, key.id, key.log, key.id);
			if (row === void 0) return void 0;
			const issues = issuesOf([key.log]);
			const lanes = q(`SELECT lane, min(model) AS model, count(*) AS calls, min(idx) AS first, max(idx) AS last
         FROM calls WHERE log = ? AND session_id = ? GROUP BY lane ORDER BY first`).all(key.log, key.id).map((r) => ({
				lane: String(r.lane),
				model: String(r.model),
				calls: Number(r.calls),
				firstCall: Number(r.first),
				lastCall: Number(r.last)
			}));
			const events = q("SELECT * FROM session_events WHERE log = ? AND session_id = ? ORDER BY ts, id").all(key.log, key.id).map(event);
			const subagents = q(`${subtreeSql("v.log = ? AND v.parent_id = ?")} SELECT * FROM v_sessions v ${SUB_JOIN}
        WHERE log = ? AND parent_id = ? ORDER BY started, id`).all(key.log, key.id, key.log, key.id).map((r) => summary(r, issues));
			return {
				...meta,
				session: summary(row, issues),
				lanes,
				events,
				compactions: compactionsOf(key, false),
				subagents,
				unlogged: estimateUnlogged(tracesOf(q(UNLOGGED_SQL).all(key.log, key.id)))
			};
		},
		listCalls(key, options = {}) {
			if (!hasSession(key)) return {
				...meta,
				total: 0,
				offset: 0,
				items: []
			};
			const tools = toolUsesOf(key);
			const lane = options.lane ?? null;
			const after = options.afterIndex ?? -1;
			const counts = q(`SELECT count(*) AS total, count(CASE WHEN idx <= ? THEN 1 END) AS before FROM calls
         WHERE log = ? AND session_id = ? AND (? IS NULL OR lane = ?)`).get(after, key.log, key.id, lane, lane);
			const items = q(`SELECT * FROM calls WHERE log = ? AND session_id = ? AND (? IS NULL OR lane = ?) AND idx > ?
         ORDER BY idx LIMIT ?`).all(key.log, key.id, lane, lane, after, options.limit ?? 1e3).map((r) => callSummary(r, tools.get(String(r.id)) ?? []));
			return {
				...meta,
				total: Number(counts?.total),
				offset: Number(counts?.before),
				items
			};
		},
		getCall(key, index) {
			const row = hasSession(key) ? callRow(key, index) : void 0;
			if (row === void 0) return void 0;
			const call = callSummary(row, toolUsesOf(key).get(String(row.id)) ?? []);
			return {
				...meta,
				call,
				raw: { params: call$1(row).params }
			};
		},
		callTimeline(key) {
			return {
				...meta,
				items: hasSession(key) ? timeline(key) : []
			};
		},
		contextAt: context,
		responseAt,
		contextDiff(key, index) {
			const now = context(key, index);
			if (now === void 0) return void 0;
			const prev = previousOf(key, now.call);
			const previous = prev?.index;
			const was = previous === void 0 ? void 0 : context(key, previous);
			const runKey = (b) => `${b.position}:${b.hash ?? ""}`;
			const real = (b) => b.hash !== void 0;
			const before = new Set((was?.blocks ?? []).filter(real).map(runKey));
			const after = new Set(now.blocks.filter(real).map(runKey));
			const newHere = now.blocks.filter((b) => real(b) && !before.has(runKey(b)));
			const goneHere = (was?.blocks ?? []).filter((b) => real(b) && !after.has(runKey(b)));
			const wasAt = new Map(goneHere.map((b) => [b.hash, b.position]));
			const moved = newHere.flatMap((b) => {
				const from = wasAt.get(b.hash);
				return from === void 0 ? [] : [{
					...b,
					from
				}];
			});
			const movedHashes = new Set(moved.map((b) => b.hash));
			const added = newHere.filter((b) => !movedHashes.has(b.hash));
			const removed = goneHere.filter((b) => !movedHashes.has(b.hash));
			const changed = [...added, ...removed].map((b) => b.position).concat(moved.flatMap((b) => [b.position, b.from]));
			const diff = {
				...meta,
				call: index,
				added,
				removed,
				moved,
				uncached: now.blocks.filter((b) => real(b) && before.has(runKey(b)) && !b.inCachedPrefix),
				cacheReadDrop: Math.max(0, (was?.call.usage?.cacheReadTokens ?? 0) - (now.call.usage?.cacheReadTokens ?? 0))
			};
			if (previous !== void 0) diff.previous = previous;
			if (prev?.modelSwitch === true) diff.modelSwitch = true;
			if (changed.length > 0) diff.firstChange = Math.min(...changed);
			return diff;
		},
		getBlock(hash, log) {
			const r = q(BLOCK_OF_LOG).get(log, hash);
			if (r === void 0) return void 0;
			const content = json$1(r.content);
			const mediaRows = [...String(r.content).matchAll(/"\$media":"([0-9a-f]+)"/g)].map((m) => m[1] ?? "").flatMap((h) => {
				const m = q("SELECT media_type, length(bytes) AS n FROM media WHERE hash = ?").get(h);
				return m === void 0 ? [] : [{
					hash: h,
					mediaType: String(m.media_type),
					bytes: Number(m.n)
				}];
			});
			return {
				...meta,
				hash,
				log,
				kind: String(r.kind),
				source: sourceOf(r),
				text: textOf(r.content),
				media: mediaRows,
				raw: { content }
			};
		},
		getMedia(block, log, hash) {
			const owner = q("SELECT k.content FROM log_blocks b JOIN blocks k ON k.hash = b.hash WHERE b.log = ? AND b.hash = ?").get(log, block);
			if (owner === void 0 || !String(owner.content).includes(`"$media":"${hash}"`)) return void 0;
			const r = q("SELECT media_type, bytes FROM media WHERE hash = ?").get(hash);
			if (r === void 0 || !(r.bytes instanceof Uint8Array)) return void 0;
			return {
				mediaType: String(r.media_type),
				bytes: r.bytes
			};
		},
		toolCalls(key) {
			if (!hasSession(key)) return {
				...meta,
				items: []
			};
			const content = (hash) => json$1(q("SELECT content FROM blocks WHERE hash = ?").get(hash)?.content);
			const out = q(`SELECT t.*, c.idx AS call_idx,
           (SELECT r.tokens FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
             AND r.session_id = t.session_id ORDER BY r.first_call LIMIT 1) AS result_tokens,
           (SELECT r.basis FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
             AND r.session_id = t.session_id ORDER BY r.first_call LIMIT 1) AS result_basis
         FROM tool_calls t LEFT JOIN calls c ON c.log = t.log AND c.id = t.call_id
         WHERE t.log = ? AND t.session_id = ? ORDER BY c.idx, t.id`).all(key.log, key.id).map((r) => {
				const t = toolCall(r, content);
				const s = {
					id: t.id,
					callId: t.callId,
					name: t.name,
					source: t.source,
					input: t.input,
					isError: t.isError,
					parallel: t.parallel
				};
				if (r.call_idx !== null) s.callIndex = Number(r.call_idx);
				if (t.durationMs !== void 0) s.durationMs = t.durationMs;
				if (t.childSessionId !== void 0) s.childSessionId = t.childSessionId;
				if (t.resultBlockHash !== void 0) s.resultBlockHash = t.resultBlockHash;
				if (r.result_tokens !== null) s.resultTokens = Number(r.result_tokens);
				if (r.result_basis !== null && r.result_basis !== void 0) s.resultBasis = String(r.result_basis);
				return s;
			});
			return {
				...meta,
				items: out
			};
		},
		compactions: (key) => ({
			...meta,
			items: compactionsOf(key, true)
		}),
		cacheBreaks(key) {
			if (!hasSession(key)) return {
				...meta,
				items: []
			};
			const items = q(`${SESSION_BREAKS} ORDER BY idx`).all(key.log, key.id).map((r) => {
				const b = {
					index: Number(r.idx),
					lane: String(r.lane),
					ts: String(r.ts),
					model: String(r.model),
					previous: {
						index: Number(r.prev_idx),
						ts: String(r.prev_ts),
						model: String(r.prev_model),
						cacheReadTokens: Number(r.prev_cache_read_tokens)
					},
					gapSeconds: Number(r.gap_seconds),
					cacheReadTokens: Number(r.cache_read_tokens),
					dropTokens: Number(r.drop_tokens),
					cacheWriteTokens: Number(r.cache_write_tokens),
					reason: String(r.reason)
				};
				if (r.break_position !== null) b.breakPosition = Number(r.break_position);
				if (r.break_block_hash !== null) {
					b.breakBlock = {
						hash: String(r.break_block_hash),
						kind: String(r.break_kind)
					};
					if (r.break_tool !== null) b.breakBlock.tool = String(r.break_tool);
				}
				return b;
			});
			return {
				...meta,
				items
			};
		},
		blockLifetimes(key, options = {}) {
			if (!hasSession(key)) return {
				...meta,
				items: []
			};
			const sort = LIFETIME_SORTS$1[options.sort ?? "cost"];
			const ranked = [...sessionLifetimes(key).values()].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0) || (a.block_hash < b.block_hash ? -1 : 1)).slice(0, Math.max(0, options.limit ?? 50));
			const blocks = ranked.length === 0 ? [] : db.prepare(`SELECT * FROM log_blocks WHERE log = ? AND hash IN (${ranked.map(() => "?").join(",")})`).all(key.log, ...ranked.map((r) => r.block_hash));
			const byHash = new Map(blocks.map((b) => [String(b.hash), b]));
			const items = ranked.map((r) => {
				const b = byHash.get(r.block_hash) ?? {};
				return {
					hash: r.block_hash,
					kind: String(b.kind),
					source: sourceOf(b),
					...lifetimeOf(r)
				};
			});
			return {
				...meta,
				items
			};
		},
		toolOutputs(key, options = {}) {
			if (!hasSession(key)) return {
				...meta,
				items: []
			};
			const lives = sessionLifetimes(key);
			const bases = new Map(q(`SELECT r.block_hash, r.basis, min(r.first_call) FROM call_blocks r JOIN tool_calls t ON t.log = r.log
           AND t.session_id = r.session_id AND t.block_hash = r.block_hash WHERE r.log = ? AND r.session_id = ?
           GROUP BY r.block_hash`).all(key.log, key.id).map((r) => [String(r.block_hash), r.basis]));
			const sort = LIFETIME_SORTS$1[options.sort ?? "cost"];
			const items = q(SESSION_TOOLS).all(key.log, key.id).map((t) => {
				const l = t.result_block_hash === null ? void 0 : lives.get(String(t.result_block_hash));
				return l === void 0 ? t : {
					...t,
					...l
				};
			}).sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0) || (String(a.tool_use_id) < String(b.tool_use_id) ? -1 : 1)).slice(0, Math.max(0, options.limit ?? 50)).map((r) => {
				const o = {
					toolUseId: String(r.tool_use_id),
					tool: String(r.tool),
					source: sourceOf(r),
					isError: Number(r.is_error) === 1,
					...lifetimeOf(r)
				};
				if (r.call_idx !== null) o.callIndex = Number(r.call_idx);
				if (r.input_summary !== null) o.inputSummary = previewOf(String(r.input_summary), 200).preview;
				if (r.result_block_hash !== null) o.resultBlockHash = String(r.result_block_hash);
				if (r.first_call !== null) o.firstCall = Number(r.first_call);
				if (r.last_call !== null) o.lastCall = Number(r.last_call);
				const own = r.call_block_hash === null ? void 0 : lives.get(String(r.call_block_hash));
				if (own !== void 0) {
					o.toolCall = {
						blockHash: own.block_hash,
						...lifetimeOf(own)
					};
					const basis = bases.get(own.block_hash);
					if (basis !== null && basis !== void 0) o.toolCall.basis = String(basis);
				}
				return o;
			});
			return {
				...meta,
				items
			};
		},
		projectMemory(project) {
			const logs = q("SELECT DISTINCT l.path, s.project FROM sessions s JOIN logs l ON l.id = s.log").all().filter((r) => {
				const p = r.project === null ? void 0 : String(r.project);
				return p !== void 0 && (p === project || lastFolder(p) === project);
			});
			const dirs = [...new Set(logs.map((r) => parentOf(String(r.path))))];
			if (dirs.length === 0) return {
				...meta,
				items: []
			};
			const docs = db.prepare(`SELECT path, content, mtime_ms, size FROM project_memory
           WHERE project_dir IN (${dirs.map(() => "?").join(",")}) ORDER BY path, project_dir`).all(...dirs).map((r) => ({
				path: String(r.path),
				content: String(r.content),
				mtimeMs: Number(r.mtime_ms),
				size: Number(r.size)
			}));
			return {
				...meta,
				items: docs
			};
		},
		publicEvent(event) {
			switch (event.kind) {
				case "calls": {
					const key = {
						log: event.logId,
						id: event.sessionId
					};
					const added = event.added.map((id, i) => ({
						id,
						index: event.addedIndexes[i] ?? -1
					}));
					return {
						kind: "calls",
						cursor: event.cursor,
						session: key,
						added,
						updated: [...event.updated]
					};
				}
				case "log-removed": return {
					kind: "log-removed",
					cursor: event.cursor,
					logId: event.logId
				};
				case "memory": {
					const dirs = new Set(event.projectDirs);
					const projects = q("SELECT DISTINCT l.path, s.project FROM sessions s JOIN logs l ON l.id = s.log").all().filter((r) => r.project !== null && dirs.has(parentOf(String(r.path)))).map((r) => String(r.project));
					const unique = [...new Set(projects)].sort();
					return unique.length === 0 ? null : {
						kind: "memory",
						cursor: event.cursor,
						projects: unique
					};
				}
			}
		},
		ingestReport() {
			const kinds = (status) => {
				const counts = /* @__PURE__ */ new Map();
				for (const r of q("SELECT log, kind, count FROM report_kinds WHERE status = ? ORDER BY seq").all(status)) counts.set(String(r.kind), (counts.get(String(r.kind)) ?? 0) + Number(r.count));
				return [...counts].map(([kind, count]) => ({
					kind,
					count
				})).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
			};
			const issues = {};
			for (const r of q(`SELECT c.log, i.value ->> '$.kind' AS kind, count(*) AS n FROM calls c, json_each(c.issues) i
         WHERE c.issues <> '[]' GROUP BY c.log, kind`).all()) {
				const kind = String(r.kind);
				issues[kind] = (issues[kind] ?? 0) + Number(r.n);
			}
			const pending = q(`SELECT log, path, size - byte_offset AS pending FROM ingest_files
         WHERE kind = 'transcript' AND error IS NULL AND size > byte_offset ORDER BY path`).all().map((r) => ({
				path: String(r.path),
				bytes: Number(r.pending)
			}));
			const requestLogs = /* @__PURE__ */ new Map();
			for (const r of q("SELECT log, request_log FROM sessions").all()) {
				const k = String(r.request_log);
				requestLogs.set(k, (requestLogs.get(k) ?? 0) + 1);
			}
			return {
				...meta,
				unknownRecords: kinds("unknown"),
				ignoredRecords: kinds("ignored"),
				unreadable: q("SELECT r.log, l.path, r.at, r.reason FROM report_unreadable r JOIN logs l ON l.id = r.log ORDER BY r.log, r.seq").all().map((r) => ({
					log: String(r.path),
					at: String(r.at),
					reason: String(r.reason)
				})),
				errors: q("SELECT log, path, error FROM ingest_files WHERE error IS NOT NULL ORDER BY path").all().map((r) => ({
					path: String(r.path),
					error: String(r.error)
				})),
				pending,
				pendingBytes: pending.reduce((n, p) => n + p.bytes, 0),
				scan: q("SELECT path, issue FROM scan_issues ORDER BY path").all().map((r) => ({
					path: String(r.path),
					issue: String(r.issue)
				})),
				issues,
				requestLogs: [...requestLogs].sort(([a], [b]) => a < b ? -1 : 1).map(([requestLog, sessions]) => ({
					requestLog,
					sessions
				}))
			};
		}
	};
}
/** The lifetime columns of a view row. */
function lifetimeOf(r) {
	const n = (v) => Number(v ?? 0);
	const l = {
		calls: n(r.calls),
		runs: n(r.runs),
		lifetimeTokens: n(r.lifetime_tokens),
		tokensByPart: {
			cacheRead: n(r.cache_read_tokens),
			cacheWrite: n(r.cache_write_tokens),
			input: n(r.input_tokens)
		},
		costUsd: {
			cacheRead: n(r.cost_cache_read_usd),
			cacheWrite: n(r.cost_cache_write_usd),
			input: n(r.cost_input_usd),
			total: n(r.lifetime_cost_usd)
		}
	};
	if (r.tokens !== null && r.tokens !== void 0) l.tokens = Number(r.tokens);
	return l;
}
/** The parameters every provider has: the provider's own stay out of the stable types. */
function stableParams(params) {
	const { provider: _, ...rest } = params;
	return rest;
}
function sourceOf(r) {
	const s = {};
	if (r.tool !== null && r.tool !== void 0) s.tool = String(r.tool);
	if (r.file_path !== null && r.file_path !== void 0) s.filePath = String(r.file_path);
	if (r.mcp_server !== null && r.mcp_server !== void 0) s.mcpServer = String(r.mcp_server);
	if (r.skill !== null && r.skill !== void 0) s.skill = String(r.skill);
	if (r.attachment !== null && r.attachment !== void 0) s.attachment = String(r.attachment);
	return s;
}
/** The folder of a path, with `/` or `\` separators. */
function parentOf(path) {
	const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return at <= 0 ? path : path.slice(0, at);
}
/** The last folder name of a path, with `/` or `\` separators. */
function lastFolder(path) {
	return path.split(/[\\/]/).filter((p) => p !== "").at(-1) ?? path;
}
[
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: blob:",
	"font-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'"
].join("; ");
const SESSION = [
	"sessions",
	":log",
	":id"
];
const CALL = [
	...SESSION,
	"calls",
	":n"
];
[...SESSION], [...CALL], [...CALL], [...CALL], [...SESSION], [...SESSION], [...SESSION], [...SESSION], [...SESSION], [...SESSION];
// packages/engine/src/cli/query-worker-pool.ts
const OFFLOAD_METHODS = ["blockLifetimes", "toolOutputs"];
import.meta.url.endsWith(".ts");
// packages/engine/src/cli/query-worker.ts
/**
* A worker thread for the query methods that can take a second on a long Session (lifetimes over every Call),
* so that the engine's event loop keeps answering meanwhile. It has its own read-only connection. Messages: `{ id, method, args }` in, `{ id, result }` or `{ id, error }` out.
*/
const options = workerData;
const port = parentPort;
if (port === null) throw new Error("query-worker runs as a worker thread");
const query = createQuery({
	db: await openReader(options.dataDir, { setup: installViews }),
	codec: claudeCodeCodec
});
port.on("message", (message) => {
	const { id, method, args } = message;
	try {
		if (!OFFLOAD_METHODS.includes(method)) throw new Error(`not a method the worker runs: ${String(method)}`);
		const run = query[method];
		port.postMessage({
			id,
			result: run(...args)
		});
	} catch (error) {
		port.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error)
		});
	}
});
port.postMessage({ ready: true });
export {};
