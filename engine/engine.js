#!/usr/bin/env node
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { Worker } from "node:worker_threads";
// packages/engine/src/cli/quiet.ts
/** Node warns that node:sqlite is experimental on each run; that is not news to a user of qx. Other warnings print. */
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
	process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
// packages/engine/src/core/graph.ts
/** Counts by kind, summed; kinds keep the order they were first seen in. */
function addCounts(total, more) {
	const out = total.map((e) => ({ ...e }));
	for (const { kind, count } of more) {
		const entry = out.find((e) => e.kind === kind);
		if (entry === void 0) out.push({
			kind,
			count
		});
		else entry.count += count;
	}
	return out;
}
// packages/engine/src/providers/anthropic/estimate.ts
/**
* Characters per token. Fitted on the 2.1.322 fixtures (Opus 5.5 tokenizer): the tool schemas and system prompt,
* 35 406 characters, are 10 772 exact tokens (3.29). Prose is a little longer per token; the split is reconciled to
* the exact total in any case.
*/
const CHARS_PER_TOKEN$1 = 3.3;
/** Image tokens are width x height / 750, after the image is scaled to at most 1568 pixels on its long edge. */
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_MAX_EDGE = 1568;
/** The default estimator for Anthropic content. Pass another to `estimateRequest` to change it. */
const estimateBlock = (block) => {
	const estimate = estimateContent(block.content);
	const min = minimumTokens(block.content);
	return min === void 0 ? estimate : {
		...estimate,
		min
	};
};
/** The fewest tokens a tool result can have: its tool use id and the structure of a block. */
function minimumTokens(content) {
	const block = asObject$1(content);
	if (block?.type !== "tool_result") return void 0;
	return Math.ceil(String(block.tool_use_id ?? "").length / CHARS_PER_TOKEN$1) + 5;
}
function estimateContent(content) {
	const parts = partsOf$1(content);
	if (parts.some((part) => part.method === "unknown")) return {
		tokens: 0,
		method: "unknown"
	};
	const chars = parts.reduce((sum, part) => sum + part.chars, 0);
	const imageTokens = parts.reduce((sum, part) => sum + part.imageTokens, 0);
	return {
		tokens: Math.ceil(chars / CHARS_PER_TOKEN$1) + imageTokens + 5,
		method: imageTokens > 0 ? "image" : "chars"
	};
}
/** The measurable parts of one content block: its text, its JSON, the images and documents it holds. */
function partsOf$1(content) {
	const block = asObject$1(content);
	const chars = (n) => ({
		method: "chars",
		chars: n,
		imageTokens: 0
	});
	if (block === void 0) return [chars(JSON.stringify(content).length)];
	switch (block.type) {
		case "text": return [chars(String(block.text ?? "").length)];
		case "thinking": return [chars(String(block.thinking ?? "").length)];
		case "redacted_thinking": return [chars(0)];
		case "tool_use": return [chars(String(block.id ?? "").length + String(block.name ?? "").length + JSON.stringify(block.input ?? null).length)];
		case "tool_result": {
			const id = chars(String(block.tool_use_id ?? "").length);
			const inner = block.content;
			if (typeof inner === "string") return [id, chars(inner.length)];
			return Array.isArray(inner) ? [id, ...inner.flatMap(partsOf$1)] : [id];
		}
		case "tool_reference": return [chars(String(block.tool_name ?? "").length)];
		case "image": {
			const tokens = imageTokens(block);
			return [tokens === void 0 ? {
				method: "unknown",
				chars: 0,
				imageTokens: 0
			} : {
				method: "image",
				chars: 0,
				imageTokens: tokens
			}];
		}
		case "document": return [{
			method: "unknown",
			chars: 0,
			imageTokens: 0
		}];
		default: return [chars(JSON.stringify(content).length)];
	}
}
function imageTokens(block) {
	const data = asObject$1(block.source)?.data;
	const size = typeof data === "string" ? imageSize(data) : void 0;
	if (size === void 0) return void 0;
	const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(size.width, size.height));
	return Math.ceil(Math.round(size.width * scale) * Math.round(size.height * scale) / IMAGE_PIXELS_PER_TOKEN);
}
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
function asObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
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
/** For a reasoning block: whether its text is there (`full`), only its signature (`omitted`), or encrypted. */
function reasoningShown(content) {
	const block = asObject(content);
	if (block?.type === "redacted_thinking") return "redacted";
	if (block?.type !== "thinking") return void 0;
	return typeof block.thinking === "string" && block.thinking !== "" ? "full" : "omitted";
}
/** The tool names a content block loads with `tool_reference` blocks (in a tool result). */
function toolReferences(content) {
	const block = asObject(content);
	if (block === void 0) return [];
	if (block.type === "tool_reference" && typeof block.tool_name === "string") return [block.tool_name];
	return Array.isArray(block.content) ? block.content.flatMap(toolReferences) : [];
}
/** A tool schema with `defer_loading`: it is sent only where a `tool_reference` loads it. */
function isDeferredSchema(tool) {
	return asObject(tool)?.defer_loading === true;
}
/**
* Whether the model keeps the thinking of earlier assistant turns in its context (and bills it as input). Claude
* Opus 4.5 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos do; earlier models drop it, except in the
* last assistant turn of a tool loop.
*/
function replaysThinking(canonicalModel) {
	if (canonicalModel === void 0) return true;
	if (/^claude-(fable|mythos)-/.test(canonicalModel)) return true;
	const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(canonicalModel);
	if (match === null) return true;
	const version = Number(match[2]) + Number(match[3] ?? 0) / 10;
	if (match[1] === "opus") return version >= 4.5;
	if (match[1] === "sonnet") return version >= 5;
	return version >= 5.5;
}
/** The content block types of Anthropic messages that this code knows. */
const KNOWN_CONTENT_TYPES = /* @__PURE__ */ new Set([
	"text",
	"thinking",
	"redacted_thinking",
	"tool_use",
	"tool_result",
	"image",
	"document"
]);
// packages/engine/src/core/pricing.ts
/** The cost of a Usage by part. A cache write with no time-to-live split is priced as 5 minutes. */
function costOf(usage, sheet) {
	const usd = (tokens, perMillion) => tokens * perMillion / 1e6;
	const split = usage.cacheWrite5mTokens !== void 0 && usage.cacheWrite1hTokens !== void 0;
	const write5m = split ? usage.cacheWrite5mTokens ?? 0 : usage.cacheWriteTokens;
	const write1h = split ? usage.cacheWrite1hTokens ?? 0 : 0;
	const inputUsd = usd(usage.inputTokens, sheet.input);
	const cacheReadUsd = usd(usage.cacheReadTokens, sheet.cacheRead);
	const cacheWriteUsd = usd(write5m, sheet.cacheWrite5m) + usd(write1h, sheet.cacheWrite1h);
	const outputUsd = usd(usage.outputTokens, sheet.output);
	const { model, source, date, modifiers } = sheet;
	return {
		inputUsd,
		cacheReadUsd,
		cacheWriteUsd,
		outputUsd,
		totalUsd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
		price: {
			model,
			source,
			date,
			modifiers
		}
	};
}
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
const PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const DATE = "2026-11-12";
/** Cache writes cost a multiple of the input price, by time to live. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const PREMIUM = 1.1;
/** Above this prompt size a `[1m]` model before Claude 4.6 may have a long-context price that is not modelled. */
const LONG_CONTEXT = 2e5;
/** The largest context window of any Claude model (1M tokens): no single request can send more input. */
const MAX_CONTEXT_WINDOW = 1e6;
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
/** Anthropic first-party list prices per million tokens, from PRICE_SOURCE on DATE. */
const PRICES = {
	"claude-fable-5-2": p(8, 40, .2, { fast: {
		input: 16,
		output: 80
	} }),
	"claude-mythos-5-2": p(8, 40, .2, { fast: {
		input: 16,
		output: 80
	} }),
	"claude-fable-5-1": p(10, 50, .25),
	"claude-mythos-5-1": p(10, 50, .25),
	"claude-fable-5": p(10, 50, 1),
	"claude-mythos-5": p(10, 50, 1),
	"claude-opus-5-5": p(4, 20, .2, { fast: {
		input: 8,
		output: 40
	} }),
	"claude-opus-5": p(5, 25, .5, { fast: {
		input: 10,
		output: 50
	} }),
	"claude-opus-4-8": p(5, 25, .5, { fast: {
		input: 10,
		output: 50
	} }),
	"claude-opus-4-7": p(5, 25, .5),
	"claude-opus-4-6": p(5, 25, .5),
	"claude-opus-4-5": p(5, 25, .5, BEFORE_4_6),
	"claude-opus-4-1": p(15, 75, 1.5, BEFORE_4_5),
	"claude-opus-4": p(15, 75, 1.5, BEFORE_4_5),
	"claude-sonnet-5-5": p(2, 10, .1),
	"claude-sonnet-5": p(2, 10, .2),
	"claude-sonnet-4-6": p(3, 15, .3),
	"claude-sonnet-4-5": p(3, 15, .3, BEFORE_4_6),
	"claude-sonnet-4": p(3, 15, .3, BEFORE_4_5),
	"claude-haiku-5-5": p(.1, .5, .01, { longPrompt: {
		over: 1e5,
		input: .5,
		output: 2.5,
		cacheRead: .05
	} }),
	"claude-haiku-4-5": p(1, 5, .1, BEFORE_4_6)
};
/**
* The canonical id of a model id from any provider, or undefined when no price is known for it. Drops a Bedrock
* region and `anthropic.` prefix, a `-v1:0` version, a `[1m]` context suffix, and a snapshot date (`-20250929`,
* Vertex `@20251101`).
*/
function canonicalModel(id) {
	const base = id.replace(/\[[^\]]*\]$/, "").replace(/^(?:[a-z-]+\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/(?:-|@)\d{8}$/, "");
	return base in PRICES ? base : void 0;
}
/** The cost of one Call, with the modifiers that applied, and what had to be assumed. */
function priceCall(usage, context) {
	const model = canonicalModel(context.model);
	const price = model === void 0 ? void 0 : PRICES[model];
	if (model === void 0 || price === void 0) return { issues: [{
		kind: "no-price",
		detail: `no list price for model ${context.model}`
	}] };
	const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return {
		cost: costOf(usage, sheetFor(model, price, context, prompt)),
		issues: assumptions(usage, model, price, context, prompt)
	};
}
function sheetFor(model, price, context, prompt) {
	const modifiers = [];
	let { input, output, cacheRead } = price;
	if (price.longPrompt !== void 0 && prompt > price.longPrompt.over) {
		({input, output, cacheRead} = price.longPrompt);
		modifiers.push(`prompt over ${price.longPrompt.over} tokens`);
	}
	if (context.speed === "fast" && price.fast !== void 0) {
		cacheRead = price.fast.input * (cacheRead / input);
		({input, output} = price.fast);
		modifiers.push("fast mode");
	}
	let factor = 1;
	if (price.regionalPremium && isBedrockRegional(context.model)) {
		factor *= PREMIUM;
		modifiers.push("Bedrock regional endpoint +10%");
	}
	if (price.usOnlyPremium && context.inferenceGeo === "us") {
		factor *= PREMIUM;
		modifiers.push("US-only inference x1.1");
	}
	return {
		model,
		source: PRICE_SOURCE,
		date: DATE,
		modifiers,
		input: input * factor,
		output: output * factor,
		cacheRead: cacheRead * factor,
		cacheWrite5m: input * CACHE_WRITE_5M * factor,
		cacheWrite1h: input * CACHE_WRITE_1H * factor
	};
}
/** A Bedrock id with a geographic prefix (`eu.`, `us.`, `apac.`, `us-gov.`, …) is regional; `global.` and a bare id are not. */
function isBedrockRegional(id) {
	const prefix = /^([a-z-]+)\.anthropic\./.exec(id)?.[1];
	return prefix !== void 0 && prefix !== "global";
}
function assumptions(usage, model, price, context, prompt) {
	const issues = [];
	const { cacheWriteTokens: write, cacheWrite5mTokens: w5, cacheWrite1hTokens: w1 } = usage;
	if (w5 === void 0 || w1 === void 0) {
		if (write > 0) issues.push({
			kind: "price-assumption",
			detail: "cache write time to live unknown; priced as 5 minutes"
		});
	} else if (w5 + w1 !== write) issues.push({
		kind: "price-assumption",
		detail: `cache write ${write} is not 5m ${w5} + 1h ${w1}; priced by the split`
	});
	if (!price.longContextVerified && /\[1m\]$/.test(context.model) && prompt > LONG_CONTEXT) {
		const detail = `prompt over ${LONG_CONTEXT} tokens on ${model}: long-context price not verified`;
		issues.push({
			kind: "price-assumption",
			detail
		});
	}
	return issues;
}
// packages/engine/src/adapters/claude-code/attached.ts
/** Attachment types that Claude Code logs before a request but often does not send in it (seen on real logs). */
const OFTEN_UNSENT = /* @__PURE__ */ new Set(["total_tokens_reminder"]);
const WRAPPED = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>$/;
/** The forms in which an attached text can be sent: as logged, then without its wrapper. */
function sentForms(text) {
	const trimmed = text.trim();
	const inner = WRAPPED.exec(trimmed)?.[1];
	return inner === void 0 || inner.trim() === "" ? [trimmed] : [trimmed, inner];
}
/** Whether a text holds one of the forms of an attached text. */
function holds(text, attached) {
	return sentForms(attached.text).some((form) => form !== "" && text.includes(form));
}
const LABELS = {
	agent_listing_delta: "Agent listing",
	auto_mode: "Auto mode",
	date: "Date",
	deferred_tools_delta: "Deferred tools",
	diagnostics: "Diagnostics",
	directory: "Directory",
	edited_text_file: "Edited file",
	environment: "Environment",
	file: "File",
	mcp_instructions_delta: "MCP instructions",
	model: "Model",
	plan_mode: "Plan mode",
	queued_command: "Queued command",
	session_context: "Session context",
	silent_turn_reminder: "Turn reminder",
	skill_listing: "Skill listing",
	total_tokens_reminder: "Token reminder"
};
/** A short name for people; a type not listed reads as its words ("todo_reminder": "Todo reminder"). */
function labelOf(type) {
	const known = Object.hasOwn(LABELS, type) ? LABELS[type] : void 0;
	if (known !== void 0) return known;
	const words = type.replace(/_delta$/, "").replaceAll("_", " ").trim();
	return words === "" ? "Attachment" : words[0]?.toUpperCase() + words.slice(1);
}
const LEFTOVER_LABEL = "Other text";
/** The source a part of an attached text gets. */
function sourceOf$1(attached) {
	return attached.path === void 0 ? { attachment: attached.type } : {
		attachment: attached.type,
		filePath: attached.path
	};
}
/**
* The parts of `text`: each attached text found in it as a substring (in the order given, each at its first place
* not taken yet), and the text between them that none accounts for. Blank space between two spans joins the span
* before it, so the parts cover `text` end to end. Undefined when no attached text is in it.
*/
function partsOf(text, attached) {
	const spans = [];
	const free = (start, end) => spans.every((s) => end <= s.start || start >= s.end);
	for (const a of attached) for (const form of sentForms(a.text)) {
		if (form === "") continue;
		let at = text.indexOf(form);
		while (at >= 0 && !free(at, at + form.length)) at = text.indexOf(form, at + 1);
		if (at >= 0) {
			spans.push({
				start: at,
				end: at + form.length,
				attached: a
			});
			break;
		}
	}
	if (spans.length === 0) return void 0;
	spans.sort((a, b) => a.start - b.start);
	const parts = [];
	const leftover = (start, end) => {
		const last = parts.at(-1);
		const lead = text.slice(start, end).search(/\S/);
		if (lead < 0) {
			if (last !== void 0) last.end = end;
		} else {
			if (last !== void 0) last.end = start + lead;
			const from = last === void 0 ? start : start + lead;
			parts.push({
				start: from,
				end,
				label: LEFTOVER_LABEL,
				source: {}
			});
		}
	};
	let at = 0;
	for (const s of spans) {
		if (s.start > at) leftover(at, s.start);
		parts.push({
			start: s.start,
			end: s.end,
			label: labelOf(s.attached.type),
			source: sourceOf$1(s.attached)
		});
		at = s.end;
	}
	if (at < text.length) leftover(at, text.length);
	if (parts[0] !== void 0 && parts[0].start > 0) parts[0].start = 0;
	return { parts };
}
const MAX_ATTACHED_CHARS = 262144;
/** `attached` with `added` as the newest (an equal older text goes), cut to the bounds from the oldest. */
function remember(attached, added) {
	const out = [...attached.filter((a) => a.text.trim() !== added.text.trim()), added].slice(-64);
	let chars = out.reduce((sum, a) => sum + a.text.length, 0);
	while (out.length > 1 && chars > MAX_ATTACHED_CHARS) chars -= out.shift()?.text.length ?? 0;
	return out;
}
// packages/engine/src/adapters/claude-code/records.ts
/**
* Read and write the state's records by keys that come from the log. A key such as `__proto__` must stay a plain
* key: plain assignment would change the object's prototype instead.
*/
function get(record, key) {
	return Object.hasOwn(record, key) ? record[key] : void 0;
}
function put$1(record, key, value) {
	Object.defineProperty(record, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
	return value;
}
// packages/engine/src/adapters/claude-code/changes.ts
var Changes = class {
	sessions = /* @__PURE__ */ new Set();
	calls = /* @__PURE__ */ new Set();
	toolCalls = /* @__PURE__ */ new Set();
	compactions = /* @__PURE__ */ new Set();
	blocks = [];
	runs = /* @__PURE__ */ new Map();
	/** Records by key: a later write of the same key in one read replaces the earlier. */
	records = /* @__PURE__ */ new Map();
	events = [];
	report = {
		unknownRecords: [],
		ignoredRecords: [],
		unreadable: []
	};
	run(run) {
		this.runs.set(run.id, run);
	}
	/** The delta, as copies: later reads must not change what the caller holds. */
	delta(state) {
		const pick = (record, ids) => [...ids].flatMap((id) => {
			const item = get(record, id);
			return item === void 0 ? [] : [item];
		});
		const calls = pick(state.calls, this.calls);
		for (const call of calls) call.issues.sort(byKindAndDetail);
		return structuredClone({
			sessions: pick(state.sessions, this.sessions),
			calls,
			blocks: this.blocks,
			callBlocks: [...this.runs.values()],
			toolCalls: pick(state.toolCalls, this.toolCalls),
			compactions: pick(state.compactions, this.compactions),
			events: this.events,
			report: this.report,
			records: [...this.records.values()]
		});
	}
};
function byKindAndDetail(a, b) {
	return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}
// packages/engine/src/adapters/claude-code/json.ts
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : void 0;
}
function num$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function obj(value) {
	return isObject(value) ? value : void 0;
}
function arr(value) {
	return Array.isArray(value) ? value : void 0;
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
const AT_FILE_CALL = /^<system-reminder>\nCalled the (\S+) tool with the following input: (\{.*\})\n<\/system-reminder>/s;
const AT_FILE_RESULT = /^<system-reminder>\nResult of calling the (\S+) tool:/;
function createClassifier(store, sink, estimator) {
	const messages = /* @__PURE__ */ new Map();
	const shapes = /* @__PURE__ */ new Map();
	const ref = (role, content, contentIndex) => {
		const hash = blockHash(role, content);
		const fresh = !store.seen(hash);
		const { kind, source, parts, unknownType } = classify(role, obj(content) ?? {}, store, fresh);
		const block = {
			hash,
			kind,
			source,
			text: blockText(content),
			content
		};
		if (parts !== void 0) block.parts = parts;
		if (fresh) {
			store.markSeen(hash);
			sink(block, unknownType);
		}
		const out = {
			hash,
			kind,
			contentIndex,
			estimate: estimator(block),
			references: toolReferences(content)
		};
		const toolUseId = kind === "tool-result" ? str(obj(content)?.tool_use_id) : void 0;
		if (toolUseId !== void 0) out.toolUseId = toolUseId;
		return out;
	};
	return {
		message(hash) {
			const cached = messages.get(hash);
			if (cached !== void 0) return cached;
			const message = store.message(hash);
			if (message === void 0) return void 0;
			const refs = message.content.map((content, i) => ref(message.role, content, i));
			messages.set(hash, refs);
			return refs;
		},
		gap(messageHash) {
			const content = {
				type: "gap",
				message: messageHash
			};
			const hash = blockHash("gap", content);
			if (!store.seen(hash)) {
				store.markSeen(hash);
				sink({
					hash,
					kind: "gap",
					source: {},
					text: gapText(messageHash),
					content
				}, void 0);
			}
			return {
				hash,
				kind: "gap",
				contentIndex: 0,
				estimate: {
					tokens: 0,
					method: "unknown"
				},
				references: []
			};
		},
		shape(hash) {
			const cached = shapes.get(hash);
			if (cached !== void 0) return cached;
			const shape = store.shape(hash);
			if (shape === void 0) return void 0;
			const refs = [];
			const sections = [];
			const deferred = {};
			for (const [i, tool] of shape.tools.entries()) {
				const r = ref("tools", tool, i);
				if (isDeferredSchema(tool)) {
					put$1(deferred, str(obj(tool)?.name) ?? "", r);
					continue;
				}
				refs.push(r);
				sections.push("tools");
			}
			const toolCount = refs.length;
			for (const [i, block] of shape.system.entries()) {
				refs.push(ref("system", block, i));
				sections.push("system");
			}
			const result = {
				refs,
				sections,
				toolCount,
				key: sha256Sorted(refs.map((r) => r.hash)),
				deferred
			};
			shapes.set(hash, result);
			return result;
		}
	};
}
/** The hash of a content block, with the role it is sent in (so equal text as system and as user stays apart). */
function blockHash(role, content) {
	return sha256Sorted({
		role,
		block: content
	});
}
/** Kind and source of one content block. `fresh`: first seen, so it may update what later blocks refer to. */
function classify(role, block, store, fresh) {
	if (role === "tools") return {
		kind: "tool-schema",
		source: toolSource(str(block.name))
	};
	const type = str(block.type) ?? "";
	if (!KNOWN_CONTENT_TYPES.has(type)) return {
		kind: roleKind(role),
		source: {},
		unknownType: type
	};
	if (role === "system") return attached({
		kind: "system",
		source: {}
	}, str(block.text) ?? "", store.state);
	switch (type) {
		case "thinking":
		case "redacted_thinking": return {
			kind: "reasoning",
			source: {}
		};
		case "tool_use": {
			const source = toolSource(str(block.name), obj(block.input));
			store.putToolSource(str(block.id) ?? "", source);
			return {
				kind: "tool-call",
				source
			};
		}
		case "tool_result": {
			const id = str(block.tool_use_id) ?? "";
			return {
				kind: "tool-result",
				source: store.toolCall(id)?.source ?? store.toolSource(id) ?? {}
			};
		}
		case "image": return {
			kind: "image",
			source: {}
		};
		case "document": return {
			kind: "document",
			source: {}
		};
		default: return role === "assistant" ? {
			kind: "assistant",
			source: {}
		} : userText(str(block.text) ?? "", store.state, fresh);
	}
}
/** A user-role text: a reminder when the harness attached all of it. */
function userText(text, state, fresh) {
	const plain = plainUserText(text, state, fresh);
	if (plain.kind === "summary") return plain;
	const out = attached(plain, text, state);
	return out.parts?.every((p) => p.source.attachment !== void 0) ? {
		...out,
		kind: "reminder"
	} : out;
}
/**
* A text with the parts the harness attached to it, when it attached any: one attached text that is all of it
* gives the Block its source. The same attached text may be sent again in another Block, so it stays.
*/
function attached(plain, text, state) {
	const located = partsOf(text, state.attached);
	if (located === void 0) return plain;
	const { parts } = located;
	const [only] = parts;
	if (parts.length > 1 || only === void 0) return {
		...plain,
		parts
	};
	const source = {
		...plain.source,
		...only.source
	};
	if (plain.source.filePath !== void 0) source.filePath = plain.source.filePath;
	return {
		kind: plain.kind,
		source,
		parts
	};
}
function plainUserText(text, state, fresh) {
	const hash = textHash(text);
	if (get(state.summaries, hash) !== void 0) return {
		kind: "summary",
		source: {}
	};
	const skill = get(state.skills, hash);
	if (skill !== void 0) return {
		kind: "reminder",
		source: {
			tool: "Skill",
			skill
		}
	};
	if (isNotice(text)) return {
		kind: "reminder",
		source: {}
	};
	if (!text.startsWith("<system-reminder>")) return {
		kind: "user",
		source: {}
	};
	const call = AT_FILE_CALL.exec(text);
	if (call !== null) {
		const source = toolSource(call[1], parseObject(call[2] ?? ""));
		if (fresh) state.lastFileCall = source;
		return {
			kind: "reminder",
			source
		};
	}
	const result = AT_FILE_RESULT.exec(text);
	if (result !== null) {
		const last = state.lastFileCall;
		return {
			kind: "reminder",
			source: last !== void 0 && last.tool === result[1] ? last : toolSource(result[1])
		};
	}
	return {
		kind: "reminder",
		source: {}
	};
}
/**
* A user-role text that Claude Code writes, not the user: a local command's caveat and output, an interrupt
* marker, the note after a tool search. The command the user typed (`<command-name>`) is not one.
*/
function isNotice(text) {
	return text === "Tool loaded." || text.startsWith("[Request interrupted by user") || /^<local-command-(caveat|stdout|stderr)>/.test(text);
}
/** The key under which the state remembers a text (summaries, skills). */
function textHash(text) {
	return sha256Sorted(text);
}
/** The source of a tool: its name, its MCP server (`mcp__<server>__<tool>`), the file and skill in its input. */
function toolSource(name, input) {
	if (name === void 0) return {};
	const source = { tool: name };
	const server = /^mcp__(.+?)__/.exec(name)?.[1];
	if (server !== void 0) source.mcpServer = server;
	const filePath = str(input?.file_path);
	if (filePath !== void 0) source.filePath = filePath;
	const skill = str(input?.skill);
	if (name === "Skill" && skill !== void 0) source.skill = skill;
	return source;
}
function roleKind(role) {
	if (role === "system") return "system";
	return role === "assistant" ? "assistant" : "user";
}
function parseObject(text) {
	try {
		return obj(JSON.parse(text));
	} catch {
		return;
	}
}
// packages/engine/src/core/attribute.ts
/** Attribute one Call's input total to its kept and new Blocks. */
function attributeCall(input) {
	const { usage, kept, fresh } = input;
	const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
	const count = kept.count + fresh.length;
	const lastBp = input.lastBreakpoint;
	const framingTokens = cached > 0 && lastBp === count - 1 && count > 0 ? usage.inputTokens : 0;
	const anchors = [{
		end: count,
		sum: total - framingTokens
	}];
	if (cached > 0 && lastBp !== void 0 && lastBp >= kept.count && lastBp < count - 1) anchors.unshift({
		end: lastBp + 1,
		sum: cached
	});
	const split = splitFresh(input, anchors);
	if (typeof split !== "string") {
		const { clamped, ...rest } = split;
		return {
			...rest,
			framingTokens,
			issues: clampIssues(clamped)
		};
	}
	const all = [...kept.estimates(), ...fresh.map((f) => f.estimate)].map((estimate) => ({ estimate }));
	const again = splitFresh({
		...input,
		kept: {
			...kept,
			count: 0,
			tokens: 0,
			exact: true
		},
		fresh: all
	}, [{
		end: count,
		sum: total - framingTokens
	}]);
	const shares = typeof again === "string" ? all.map(() => ({
		tokens: 0,
		basis: "estimate"
	})) : again.fresh;
	return {
		kept: shares.slice(0, kept.count),
		fresh: shares.slice(kept.count),
		framingTokens,
		issues: [{
			kind: "unreconciled-tokens",
			detail: split
		}],
		groups: typeof again === "string" ? [] : again.groups
	};
}
function clampIssues(raised) {
	if (raised.length === 0) return [];
	const first = raised[0];
	return [{
		kind: "estimate-clamped",
		detail: raised.length === 1 ? `1 block raised to its lower bound (${first.min} tokens instead of ${first.share})` : `${raised.length} blocks raised to their lower bounds`
	}];
}
/** Split each range between anchors over its new Blocks; a reason when the kept tokens do not fit. */
function splitFresh(input, anchors) {
	const { kept, fresh, usage, id } = input;
	const out = [];
	const groups = [];
	const clamped = [];
	let start = kept.count;
	let sumBefore = kept.tokens;
	let exactBefore = kept.exact;
	for (const [rangeIndex, anchor] of anchors.entries()) {
		const range = fresh.slice(start - kept.count, anchor.end - kept.count);
		const carriedSum = range.reduce((sum, f) => sum + (f.carried?.tokens ?? 0), 0);
		const carriedPerGroup = /* @__PURE__ */ new Map();
		for (const f of range) {
			const g = f.carried?.group;
			if (g !== void 0) carriedPerGroup.set(g, (carriedPerGroup.get(g) ?? 0) + 1);
		}
		const whole = (g) => g !== void 0 && carriedPerGroup.get(g) === input.groupSize?.(g);
		const exact = exactBefore && range.every((f) => f.carried === void 0 || f.carried.basis !== "estimate" || whole(f.carried.group));
		const rest = anchor.sum - sumBefore - carriedSum;
		const fresher = range.filter((f) => f.carried === void 0);
		if (rest < 0) return `blocks kept from the previous call have ${sumBefore + carriedSum} tokens, more than ${anchor.sum}`;
		if (fresher.length === 0 && rest !== 0) return `${rest} tokens more than the previous call, but no new block`;
		const estimates = fresher.map((f) => f.estimate);
		const { shares, raised } = withBounds(reconcile(estimates, rest), estimates);
		clamped.push(...raised);
		const group = exact && fresher.length > 1 ? `${id}#${rangeIndex}` : void 0;
		const outputs = estimates.filter((e) => e.method === "output").length;
		const anchored = exact && outputs > 0 && outputs === fresher.length - 1;
		if (group !== void 0) groups.push({
			id: group,
			size: fresher.length
		});
		let next = 0;
		for (const f of range) {
			if (f.carried !== void 0) {
				out.push(f.carried);
				continue;
			}
			const method = estimates[next]?.method;
			const tokens = shares[next++] ?? 0;
			const basis = anchored && method !== "output" ? "anchored" : "estimate";
			if (fresher.length === 1 && exact) out.push({
				tokens,
				basis: usage.basis
			});
			else out.push(group === void 0 ? {
				tokens,
				basis
			} : {
				tokens,
				basis,
				group
			});
		}
		start = anchor.end;
		sumBefore = anchor.sum;
		exactBefore = true;
	}
	return {
		fresh: out,
		groups,
		clamped
	};
}
/**
* Raise shares below their Block's lower bound to it, and take the difference from the others: first from Blocks
* weighted by output tokens, then from the largest, never below their own bound. The sum stays the same.
*/
function withBounds(shares, estimates) {
	const out = [...shares];
	const raised = [];
	const raisedAt = /* @__PURE__ */ new Set();
	let deficit = 0;
	estimates.forEach((e, i) => {
		const share = out[i] ?? 0;
		if (e.min === void 0 || share >= e.min) return;
		raised.push({
			min: e.min,
			share
		});
		raisedAt.add(i);
		deficit += e.min - share;
		out[i] = e.min;
	});
	const donors = estimates.map((e, i) => ({
		i,
		e
	})).filter(({ i }) => !raisedAt.has(i)).sort((a, b) => Number(b.e.method === "output") - Number(a.e.method === "output") || (out[b.i] ?? 0) - (out[a.i] ?? 0));
	for (const { i, e } of donors) {
		const give = Math.min(deficit, (out[i] ?? 0) - (e.min ?? 0));
		if (give <= 0) continue;
		out[i] = (out[i] ?? 0) - give;
		deficit -= give;
	}
	if (deficit > 0) return {
		shares,
		raised: []
	};
	return {
		shares: out,
		raised
	};
}
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
/**
* The number of leading Blocks that end inside the cache read, from the prefix sums of their tokens
* (`prefix(i)` is the tokens of Blocks [0, i)). A Block the cache read ends inside is not counted.
*/
function cachedPrefixLength(prefix, count, cacheRead) {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = lo + hi + 1 >> 1;
		if (prefix(mid) <= cacheRead) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
// packages/engine/src/adapters/claude-code/lane.ts
function laneOf(state, key, sessionId) {
	const id = `${sessionId}|${key}`;
	return get(state.lanes, id) ?? put$1(state.lanes, id, {
		key,
		sessionId,
		shapeCount: 0,
		messages: [],
		messageEnds: [],
		blocks: [],
		sections: [],
		messageOf: [],
		contentOf: [],
		tokens: [],
		basis: [],
		group: [],
		estimates: [],
		prefix: [0],
		lone: [0],
		runs: [],
		reasoning: [],
		groupCount: {},
		partial: {},
		deferred: [],
		gaps: []
	});
}
/** Split a Call with a complete request and a Usage; sets its tokens, framing, cache boundary and runs. */
function splitCall(ctx, call, spec, usage) {
	const { store, classifier, changes } = ctx;
	const state = store.state;
	const lane = laneOf(state, spec.lane, call.sessionId);
	if (lane.cold) warmLane(ctx, lane);
	const shape = spec.shapeHash === void 0 ? void 0 : classifier.shape(spec.shapeHash);
	if (shape === void 0) return;
	const messages = messagesOf(ctx, spec, lane);
	let shared = lane.shapeKey === shape.key ? commonPrefix(messages, lane.messages) : 0;
	const filled = filledGaps(store, lane, shared);
	shared = Math.min(shared, deferredLimit(lane, shape), thinkingLimit(store, lane, messages, call), ...filled.limits);
	const keptPos = lane.shapeKey !== shape.key ? 0 : shared === 0 ? shape.refs.length : lane.messageEnds[shared - 1] ?? 0;
	const fresh = freshEntries(classifier, shape, messages, keptPos === 0 ? 0 : shared, keptPos === 0);
	applyOutputAnchor(state, lane, messages, fresh, call);
	const pool = droppedPool(lane, keptPos);
	const breakpoints = spec.breakpoints.flatMap((path) => positionOf(path, lane, shape, shared, keptPos, fresh));
	const { keptExact, partialAfter } = keptExactness(lane, keptPos);
	const result = attributeCall({
		id: call.id,
		usage,
		kept: {
			count: keptPos,
			tokens: lane.prefix[keptPos] ?? 0,
			exact: keptExact,
			estimates: () => lane.estimates.slice(0, keptPos)
		},
		fresh: fresh.map((f) => {
			const carried = pool.get(f.ref.hash)?.shift();
			return carried === void 0 ? { estimate: f.ref.estimate } : {
				estimate: f.ref.estimate,
				carried
			};
		}),
		...breakpoints.length > 0 ? { lastBreakpoint: Math.max(...breakpoints) } : {},
		groupSize: (g) => store.groupSize(g) ?? 0
	});
	for (const g of result.groups) store.putGroupSize(g.id, g.size);
	const restart = result.kept !== void 0;
	truncate(lane, keptPos, changes);
	lane.partial = partialAfter;
	if (restart) {
		for (let p = 0; p < keptPos; p++) closeRun(lane, p, changes);
		if (result.kept !== void 0) replaceKept(lane, result.kept);
		for (let p = 0; p < keptPos; p++) openRun(lane, p, call, changes);
	}
	lane.messages.length = Math.min(lane.messages.length, keptPos === 0 ? 0 : shared);
	lane.messageEnds.length = lane.messages.length;
	if (keptPos === 0) lane.deferred = [];
	noteFilled(store, changes, filled.gaps, call.index);
	lane.shapeKey = shape.key;
	lane.shapeCount = shape.refs.length;
	appendFresh(lane, fresh, result.fresh, messages, call, changes);
	lane.lastIndex = call.index;
	lane.lastCallId = call.id;
	call.blockCount = lane.blocks.length;
	call.cacheBreakpoints = breakpoints;
	call.framingTokens = result.framingTokens;
	call.issues.push(...result.issues);
	const read = usage.cacheReadTokens;
	call.cacheBoundary = {
		tokens: read,
		position: cachedPrefixLength((i) => lane.prefix[i] ?? 0, lane.blocks.length, read)
	};
	linkResults(store, fresh, changes);
}
/**
* The message hashes of a request: the base's first `keep` messages, then the tail. A base that is the latest Call
* of any lane has its list at hand; only a base older than that needs a walk back along the chain of requests.
*/
function messagesOf(ctx, spec, lane) {
	const chain = [];
	let start = [];
	for (let at = spec; at !== void 0;) {
		chain.push(at);
		if (at.baseId === void 0) break;
		const known = lane !== void 0 && at.baseId === lane.lastCallId ? lane : latestLaneOf(ctx, at.baseId);
		if (known !== void 0) {
			start = known.messages;
			break;
		}
		at = ctx.store.spec(at.baseId);
	}
	const list = [...start];
	for (let i = chain.length - 1; i >= 0; i--) {
		const s = chain[i];
		list.length = Math.min(list.length, s.baseId === void 0 ? 0 : s.keep);
		for (const hash of s.tail) list.push(hash);
	}
	return list;
}
/** The lane whose latest split Call is `callId`, warmed if it came from a snapshot. */
function latestLaneOf(ctx, callId) {
	for (const lane of Object.values(ctx.store.state.lanes)) {
		if (lane.lastCallId !== callId) continue;
		if (lane.cold) warmLane(ctx, lane);
		return lane;
	}
}
/**
* Rebuild a lane restored from a snapshot: its layout is the open runs that the caller kept, and its message list
* is its latest Call's, walked back along the requests the caller kept as records.
*/
function warmLane(ctx, lane) {
	const { store } = ctx;
	delete lane.cold;
	const runs = store.lookup.openRuns(lane.sessionId, lane.key).sort((a, b) => a.position - b.position);
	const contentIndex = /* @__PURE__ */ new Map();
	for (const run of runs) {
		const p = lane.blocks.length;
		const block = store.lookup.block(run.blockHash);
		const message = run.message ?? -1;
		const deferred = run.section === "messages" && block?.kind === "tool-schema";
		lane.blocks.push(run.blockHash);
		lane.sections.push(run.section);
		lane.messageOf.push(message);
		const index = contentIndex.get(message) ?? 0;
		lane.contentOf.push(deferred ? -1 : index);
		if (!deferred) contentIndex.set(message, index + 1);
		const known = block !== void 0 && block.kind !== "gap";
		lane.estimates.push(known ? ctx.estimator(block) : {
			tokens: 0,
			method: "unknown"
		});
		lane.reasoning.push(block?.kind === "reasoning");
		lane.runs.push(structuredClone(run));
		setShare(lane, p, {
			tokens: run.tokens ?? 0,
			basis: run.basis ?? "estimate",
			...run.group ? { group: run.group } : {}
		});
		if (deferred) lane.deferred.push({
			position: p,
			tool: block?.source.tool ?? "",
			hash: run.blockHash
		});
		if (message >= 0) lane.messageEnds[message] = p + 1;
	}
	for (const g of Object.keys(lane.groupCount)) if ((get(lane.groupCount, g) ?? 0) < (store.groupSize(g) ?? 0)) put$1(lane.partial, g, 1);
	const spec = lane.lastCallId === void 0 ? void 0 : store.spec(lane.lastCallId);
	lane.messages = spec === void 0 ? [] : messagesOf(ctx, spec, void 0);
	for (let m = 0; m < lane.messages.length; m++) lane.messageEnds[m] ??= m === 0 ? lane.shapeCount : lane.messageEnds[m - 1] ?? lane.shapeCount;
}
function commonPrefix(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}
/**
* Gaps among the kept messages whose message has come to the log since: the kept prefix ends before each, so
* this Call gets the message's own Blocks in place of the gap.
*/
function filledGaps(store, lane, shared) {
	const gaps = lane.gaps.filter((g) => (lane.messageOf[g.position] ?? 0) < shared && store.message(g.message) !== void 0);
	return {
		gaps,
		limits: gaps.map((g) => lane.messageOf[g.position] ?? 0)
	};
}
/** The Call that got a gap first says that its message came later, and from which Call on the lane has it. */
function noteFilled(store, changes, gaps, index) {
	for (const gap of gaps) {
		const call = store.call(gap.callId);
		if (call === void 0) continue;
		const detail = `message ${gap.message} came after this call was split: Calls from index ${index} on have it`;
		if (call.issues.some((i) => i.detail === detail)) continue;
		call.issues.push({
			kind: "missing-message",
			detail
		});
		changes.calls.add(call.id);
	}
}
/** Kept messages must not hold a deferred tool schema that this Call's shape gives differently. */
function deferredLimit(lane, shape) {
	let limit = Number.POSITIVE_INFINITY;
	for (const d of lane.deferred) {
		if (get(shape.deferred, d.tool)?.hash === d.hash) continue;
		const message = lane.messageOf[d.position] ?? 0;
		limit = Math.min(limit, message);
	}
	return limit;
}
/**
* A model that drops the thinking of earlier turns sends the last assistant message differently once a newer
* assistant message follows it: from that message on, nothing is kept unchanged.
*/
function thinkingLimit(store, lane, messages, call) {
	if (replaysThinking(call.canonicalModel)) return Number.POSITIVE_INFINITY;
	const role = (hash) => store.message(hash ?? "")?.role;
	for (let m = lane.messages.length - 1; m >= 0; m--) {
		if (role(lane.messages[m]) !== "assistant") continue;
		const start = m === 0 ? lane.shapeCount : lane.messageEnds[m - 1] ?? 0;
		if (!lane.reasoning.slice(start, lane.messageEnds[m] ?? 0).some(Boolean)) return Number.POSITIVE_INFINITY;
		for (let k = m + 1; k < messages.length; k++) if (role(messages[k]) === "assistant") return m;
		return Number.POSITIVE_INFINITY;
	}
	return Number.POSITIVE_INFINITY;
}
/** The Blocks after the kept part: shape Blocks when nothing is kept, then the new messages. */
function freshEntries(classifier, shape, messages, from, withShape) {
	const out = [];
	if (withShape) for (const [i, ref] of shape.refs.entries()) out.push({
		ref,
		section: shape.sections[i] ?? "system",
		message: -1
	});
	for (let m = from; m < messages.length; m++) {
		const hash = messages[m] ?? "";
		for (const ref of classifier.message(hash) ?? [classifier.gap(hash)]) {
			out.push({
				ref,
				section: "messages",
				message: m
			});
			for (const tool of ref.references) {
				const schema = get(shape.deferred, tool);
				if (schema !== void 0) out.push({
					ref: schema,
					section: "messages",
					message: m,
					deferredTool: tool
				});
			}
		}
	}
	return out;
}
/**
* The previous Call's response comes back as the assistant message of the next tail. Its output tokens are a far
* better weight than its characters: thinking gets the reasoning tokens (none if the model drops it), the other
* Blocks the rest, split by characters. The split stays an estimate, reconciled to the exact change.
*/
function applyOutputAnchor(state, lane, messages, fresh, call) {
	const response = lane.lastCallId === void 0 ? void 0 : get(state.responses, lane.lastCallId);
	if (response?.hash === void 0) return;
	const m = messages.indexOf(response.hash);
	const own = fresh.filter((f) => f.message === m && m >= 0 && f.deferredTool === void 0);
	if (own.length === 0) return;
	const thinking = own.filter((f) => f.ref.kind === "reasoning");
	const others = own.filter((f) => f.ref.kind !== "reasoning");
	const reasoning = replaysThinking(call.canonicalModel) ? response.reasoningTokens ?? 0 : 0;
	const rest = Math.max(0, response.outputTokens - (response.reasoningTokens ?? 0));
	const weigh = (entries, total) => reconcile(entries.map((f) => f.ref.estimate), total).forEach((tokens, i) => {
		const entry = entries[i];
		if (entry !== void 0) entry.ref = {
			...entry.ref,
			estimate: {
				tokens,
				method: "output"
			}
		};
	});
	weigh(thinking, reasoning);
	weigh(others, rest);
	for (const f of fresh) if (f.message !== m && f.message >= 0) f.ref = {
		...f.ref,
		estimate: {
			...f.ref.estimate,
			method: "rest"
		}
	};
}
/** The tokens of the Blocks after the kept part, by content: the next Call may send them again elsewhere. */
function droppedPool(lane, keptPos) {
	const pool = /* @__PURE__ */ new Map();
	for (let p = keptPos; p < lane.blocks.length; p++) {
		const hash = lane.blocks[p] ?? "";
		const g = lane.group[p];
		const share = {
			tokens: lane.tokens[p] ?? 0,
			basis: lane.basis[p] ?? "estimate"
		};
		if (g !== null && g !== void 0) share.group = g;
		pool.set(hash, [...pool.get(hash) ?? [], share]);
	}
	return pool;
}
/** The kept sum is exact when no group in it lost members and no Block in it is a lone estimate. */
function keptExactness(lane, keptPos) {
	const partialAfter = {};
	for (const g of Object.keys(lane.partial)) put$1(partialAfter, g, 1);
	const lost = /* @__PURE__ */ new Map();
	for (let p = keptPos; p < lane.blocks.length; p++) {
		const g = lane.group[p];
		if (g !== null && g !== void 0) lost.set(g, (lost.get(g) ?? 0) + 1);
	}
	for (const [g, n] of lost) if ((get(lane.groupCount, g) ?? 0) - n > 0) put$1(partialAfter, g, 1);
	else delete partialAfter[g];
	return {
		keptExact: Object.keys(partialAfter).length === 0 && (lane.lone[keptPos] ?? 0) === 0,
		partialAfter
	};
}
/** The position of a cache breakpoint path in this Call's input. */
function positionOf(path, lane, shape, shared, keptPos, fresh) {
	const [section, i, , j] = path;
	if (section === "system" && typeof i === "number") return [shape.toolCount + i];
	if (section === "tools" && typeof i === "number") {
		const p = shape.refs.findIndex((r, k) => shape.sections[k] === "tools" && r.contentIndex === i);
		return p < 0 ? [] : [p];
	}
	if (section !== "messages" || typeof i !== "number" || typeof j !== "number") return [];
	if (keptPos > 0 && i < shared) {
		const start = i === 0 ? lane.shapeCount : lane.messageEnds[i - 1] ?? 0;
		for (let p = start; p < (lane.messageEnds[i] ?? 0); p++) if (lane.contentOf[p] === j) return [p];
		return [];
	}
	const k = fresh.findIndex((f) => f.message === i && f.deferredTool === void 0 && f.ref.contentIndex === j);
	return k < 0 ? [] : [keptPos + k];
}
function truncate(lane, keptPos, changes) {
	for (let p = lane.blocks.length - 1; p >= keptPos; p--) {
		closeRun(lane, p, changes);
		const g = lane.group[p];
		if (g !== null && g !== void 0) {
			const left = (get(lane.groupCount, g) ?? 1) - 1;
			if (left > 0) put$1(lane.groupCount, g, left);
			else delete lane.groupCount[g];
		}
	}
	const lists = [
		lane.blocks,
		lane.sections,
		lane.messageOf,
		lane.contentOf,
		lane.tokens,
		lane.basis,
		lane.group
	];
	for (const list of [
		...lists,
		lane.estimates,
		lane.runs,
		lane.reasoning
	]) list.length = Math.min(list.length, keptPos);
	lane.prefix.length = keptPos + 1;
	lane.lone.length = keptPos + 1;
	lane.deferred = lane.deferred.filter((d) => d.position < keptPos);
	lane.gaps = lane.gaps.filter((g) => g.position < keptPos);
}
function replaceKept(lane, shares) {
	lane.groupCount = {};
	lane.partial = {};
	for (const [p, share] of shares.entries()) setShare(lane, p, share);
}
function setShare(lane, p, share) {
	lane.tokens[p] = share.tokens;
	lane.basis[p] = share.basis;
	lane.group[p] = share.group ?? null;
	if (share.group !== void 0) put$1(lane.groupCount, share.group, (get(lane.groupCount, share.group) ?? 0) + 1);
	lane.prefix[p + 1] = (lane.prefix[p] ?? 0) + share.tokens;
	lane.lone[p + 1] = (lane.lone[p] ?? 0) + (share.basis === "estimate" && share.group === void 0 ? 1 : 0);
}
function appendFresh(lane, fresh, shares, messages, call, changes) {
	fresh.forEach((entry, k) => {
		const p = lane.blocks.length;
		lane.blocks.push(entry.ref.hash);
		lane.sections.push(entry.section);
		lane.messageOf.push(entry.message);
		lane.contentOf.push(entry.deferredTool === void 0 ? entry.ref.contentIndex : -1);
		lane.estimates.push(entry.ref.estimate);
		lane.reasoning.push(entry.ref.kind === "reasoning");
		setShare(lane, p, shares[k] ?? {
			tokens: 0,
			basis: "estimate"
		});
		if (entry.deferredTool !== void 0) lane.deferred.push({
			position: p,
			tool: entry.deferredTool,
			hash: entry.ref.hash
		});
		if (entry.ref.kind === "gap") lane.gaps.push({
			position: p,
			message: messages[entry.message] ?? "",
			callId: call.id
		});
		openRun(lane, p, call, changes);
		if (entry.section === "messages") lane.messageEnds[entry.message] = p + 1;
	});
	for (let m = lane.messages.length; m < messages.length; m++) {
		lane.messages.push(messages[m] ?? "");
		lane.messageEnds[m] ??= m === 0 ? lane.shapeCount : lane.messageEnds[m - 1] ?? lane.shapeCount;
	}
}
function openRun(lane, p, call, changes) {
	const run = {
		id: `${lane.sessionId}:${lane.key}:${call.index}:${p}`,
		sessionId: lane.sessionId,
		lane: lane.key,
		blockHash: lane.blocks[p] ?? "",
		position: p,
		section: lane.sections[p] ?? "messages",
		tokens: lane.tokens[p] ?? 0,
		basis: lane.basis[p] ?? "estimate",
		firstCall: call.index
	};
	const message = lane.messageOf[p] ?? -1;
	if (message >= 0) run.message = message;
	const group = lane.group[p];
	if (group !== null && group !== void 0) run.group = group;
	lane.runs[p] = run;
	changes.run(run);
}
function closeRun(lane, p, changes) {
	const run = lane.runs[p];
	if (run === void 0 || run.lastCall !== void 0 || lane.lastIndex === void 0) return;
	run.lastCall = lane.lastIndex;
	changes.run(run);
}
/** A tool result sent for the first time is the result Block of its ToolCall. */
function linkResults(store, fresh, changes) {
	for (const { ref } of fresh) {
		if (ref.toolUseId === void 0) continue;
		const toolCall = store.toolCall(ref.toolUseId);
		if (toolCall === void 0 || toolCall.resultBlockHash !== void 0) continue;
		toolCall.resultBlockHash = ref.hash;
		changes.toolCalls.add(toolCall.id);
	}
}
// packages/engine/src/adapters/claude-code/lookup.ts
/** Answers nothing: for a parser that never restores from a snapshot. */
const NO_LOOKUP = {
	record: () => void 0,
	block: () => void 0,
	call: () => void 0,
	toolCall: () => void 0,
	openRuns: () => []
};
var Content = class {
	state;
	lookup;
	emit;
	constructor(state, lookup, emit) {
		this.state = state;
		this.lookup = lookup;
		this.emit = emit;
	}
	message(hash) {
		return this.read(this.state.messages, "m:", hash);
	}
	putMessage(hash, message) {
		return this.write(this.state.messages, "m:", hash, message);
	}
	shape(hash) {
		return this.read(this.state.shapes, "s:", hash);
	}
	putShape(hash, shape) {
		this.write(this.state.shapes, "s:", hash, shape);
	}
	spec(id) {
		return this.read(this.state.specs, "p:", id);
	}
	putSpec(id, spec) {
		this.write(this.state.specs, "p:", id, spec);
	}
	groupSize(id) {
		return this.read(this.state.groupSizes, "g:", id);
	}
	putGroupSize(id, size) {
		this.write(this.state.groupSizes, "g:", id, size);
	}
	toolSource(id) {
		return this.read(this.state.toolSources, "t:", id);
	}
	putToolSource(id, source) {
		this.write(this.state.toolSources, "t:", id, source);
	}
	/** A Block that an earlier read reported. */
	seen(hash) {
		return get(this.state.seenBlocks, hash) !== void 0 || this.lookup.block(hash) !== void 0;
	}
	markSeen(hash) {
		put$1(this.state.seenBlocks, hash, 1);
	}
	/** A Call, taken back into the state when only the caller still has it (so it can be updated). */
	call(id) {
		const held = get(this.state.calls, id);
		if (held !== void 0) return held;
		const kept = this.lookup.call(id);
		return kept === void 0 ? void 0 : put$1(this.state.calls, id, structuredClone(kept));
	}
	toolCall(id) {
		const held = get(this.state.toolCalls, id);
		if (held !== void 0) return held;
		const kept = this.lookup.toolCall(id);
		return kept === void 0 ? void 0 : put$1(this.state.toolCalls, id, structuredClone(kept));
	}
	read(record, prefix, key) {
		const held = get(record, key);
		if (held !== void 0) return held;
		const kept = this.lookup.record(prefix + key);
		if (kept !== void 0) put$1(record, key, kept);
		return kept;
	}
	write(record, prefix, key, value) {
		put$1(record, key, value);
		this.emit({
			key: prefix + key,
			value
		});
		return value;
	}
};
// packages/engine/src/adapters/claude-code/mapping.ts
function usageOf(raw) {
	const usage = {
		basis: "exact",
		inputTokens: num$1(raw.input_tokens) ?? 0,
		cacheReadTokens: num$1(raw.cache_read_input_tokens) ?? 0,
		cacheWriteTokens: num$1(raw.cache_creation_input_tokens) ?? 0,
		outputTokens: num$1(raw.output_tokens) ?? 0
	};
	const reasoning = num$1(obj(raw.output_tokens_details)?.thinking_tokens);
	if (reasoning !== void 0) usage.reasoningOutputTokens = reasoning;
	const ttl = obj(raw.cache_creation);
	const write5m = num$1(ttl?.ephemeral_5m_input_tokens);
	const write1h = num$1(ttl?.ephemeral_1h_input_tokens);
	if (write5m !== void 0 && write1h !== void 0) {
		usage.cacheWrite5mTokens = write5m;
		usage.cacheWrite1hTokens = write1h;
	}
	return usage;
}
function paramsOf(params) {
	const betas = [...arr(params.betas) ?? [], ...arr(params.anthropic_beta) ?? []].filter((beta) => typeof beta === "string");
	const result = {};
	const provider = {};
	const maxTokens = num$1(params.max_tokens);
	if (maxTokens !== void 0) result.maxTokens = maxTokens;
	const thinking = obj(params.thinking);
	const mode = str(thinking?.type);
	if (thinking !== void 0 && mode !== void 0) {
		const budget = num$1(thinking.budget_tokens);
		result.reasoning = budget === void 0 ? { mode } : {
			mode,
			budgetTokens: budget
		};
		provider.thinking = thinking;
	}
	const effort = str(obj(params.output_config)?.effort);
	if (effort !== void 0) result.effort = effort;
	if (betas.length > 0) provider.betas = [...new Set(betas)];
	if (Object.keys(provider).length > 0) result.provider = provider;
	return result;
}
/** Set a Call's Usage and how it was served, and price it; replaces an earlier price and its issues. */
function setUsage(call, usage, raw) {
	call.usage = usage;
	const speed = str(raw?.speed);
	const tier = str(raw?.service_tier);
	const geo = str(raw?.inference_geo);
	if (speed) call.speed = speed;
	if (tier) call.serviceTier = tier;
	if (geo) call.inferenceGeo = geo;
	call.issues = call.issues.filter((i) => i.kind !== "no-usage" && i.kind !== "no-price" && i.kind !== "price-assumption");
	const { cost, issues } = priceCall(usage, {
		model: call.model,
		...call.speed === void 0 ? {} : { speed: call.speed },
		...call.inferenceGeo === void 0 ? {} : { inferenceGeo: call.inferenceGeo }
	});
	if (cost === void 0) delete call.cost;
	else call.cost = cost;
	call.issues.push(...issues);
}
const INPUT_SIDE = [
	"inputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"cacheWrite5mTokens",
	"cacheWrite1hTokens"
];
const OUTPUT_SIDE = ["outputTokens", "reasoningOutputTokens"];
/** The input side of a Usage is reported: some input, cache read or cache write counter is above 0. */
function hasInput(u) {
	return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0;
}
/** Two usages have the same input side (what the split of the Call rests on). */
function sameInput(a, b) {
	return INPUT_SIDE.every((k) => a[k] === b[k]);
}
/**
* The Usage of a response logged over several rows: the first input side that is reported (later rows of one
* message may carry 0 there, with only a cache write split), and the largest output side. The output only grows
* while a response streams, but Claude Code can log the message again later with output 0.
*/
function mergeUsage(known, next) {
	const merged = { ...hasInput(known) ? known : next };
	for (const k of OUTPUT_SIDE) {
		const v = Math.max(known[k] ?? -1, next[k] ?? -1);
		if (v < 0) delete merged[k];
		else merged[k] = v;
	}
	return merged;
}
/** The counters of `b` less those of `a`, for running sums (a counter absent on one side counts as 0). */
function usageChange(a, b) {
	const out = { ...b };
	for (const k of [...INPUT_SIDE, ...OUTPUT_SIDE]) {
		const v = (b[k] ?? 0) - (a?.[k] ?? 0);
		if (b[k] !== void 0 || a?.[k] !== void 0) out[k] = v;
	}
	return out;
}
// packages/engine/src/adapters/claude-code/rows.ts
/**
* Row types the adapter reads, or knows it does not need (UI and process state of the harness). Every other type
* is counted as unknown. A `system` row is known only by its subtype.
*/
const KNOWN_TYPES = /* @__PURE__ */ new Set([
	"api-request",
	"api-request-blob",
	"api-request-shape",
	"assistant",
	"user",
	"attachment",
	"cost-state",
	"atis-latch",
	"last-prompt",
	"queue-operation",
	"tools-used",
	"mode",
	"ai-title",
	"custom-title",
	"agent-name",
	"pr-link",
	"continued-in",
	"fork-context-ref",
	"relocated",
	"permission-mode",
	"dev-mods",
	"started",
	"result",
	"launched",
	"file-history-snapshot",
	"file-history-delta",
	"worktree-state"
]);
const KNOWN_SYSTEM_SUBTYPES = /* @__PURE__ */ new Set([
	"compact_boundary",
	"turn_duration",
	"away_summary",
	"local_command",
	"stop_hook_summary",
	"informational",
	"scheduled_task_fire",
	"agents_killed"
]);
/**
* The row of one complete line, or undefined for a blank, unknown or unreadable line (counted in `report`, the
* report of this read).
*/
function readLine(at, line, report) {
	if (line.trim() === "") return void 0;
	const data = parseLine(line);
	if (typeof data === "string") {
		report.unreadable.push({
			at,
			reason: data
		});
		return;
	}
	const kind = kindOf(data);
	if (kind === void 0) {
		report.unreadable.push({
			at,
			reason: "row has no type"
		});
		return;
	}
	if (isKnown(kind)) return {
		at,
		type: kind,
		data
	};
	countUnknown(report, kind);
}
/** Add one to the count of an unknown record kind. Any string is a safe kind, also `__proto__`. */
function countUnknown(report, kind) {
	addOne(report.unknownRecords, kind);
}
/** Add one to the count of a known record kind that holds nothing for the domain. */
function countIgnored(report, kind) {
	addOne(report.ignoredRecords, kind);
}
function addOne(counts, kind) {
	const entry = counts.find((e) => e.kind === kind);
	if (entry === void 0) counts.push({
		kind,
		count: 1
	});
	else entry.count++;
}
/** Lines longer than this, or nested deeper, are reported as unreadable instead of parsed. */
const MAX_LINE_CHARS = 67108864;
const MAX_DEPTH = 256;
function parseLine(line) {
	if (line.length > MAX_LINE_CHARS) return `line is longer than ${MAX_LINE_CHARS} characters`;
	if (nestingDepth(line) > MAX_DEPTH) return `JSON is nested deeper than ${MAX_DEPTH} levels`;
	let value;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return `not JSON: ${error.message}`;
	}
	return isObject(value) ? value : "not a JSON object";
}
/** The row type, with the subtype for `system` rows (`system/compact_boundary`). */
function kindOf(data) {
	const type = str(data.type);
	if (type !== "system") return type;
	return `system/${str(data.subtype) ?? "?"}`;
}
function isKnown(kind) {
	if (kind.startsWith("system/")) return KNOWN_SYSTEM_SUBTYPES.has(kind.slice(7));
	return KNOWN_TYPES.has(kind);
}
/** The deepest bracket nesting of a JSON text, outside strings. Stops counting once past the limit. */
function nestingDepth(text) {
	let depth = 0;
	let max = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (inString) {
			if (c === 92) i++;
			else if (c === 34) inString = false;
		} else if (c === 34) inString = true;
		else if (c === 91 || c === 123) {
			if (++depth > max) max = depth;
			if (max > MAX_DEPTH) return max;
		} else if (c === 93 || c === 125) depth--;
	}
	return max;
}
function emptyState() {
	return {
		version: 5,
		transcripts: {},
		messages: {},
		assistant: {},
		assistantHashes: {},
		shapes: {},
		specs: {},
		sessions: {},
		calls: {},
		nextIndex: {},
		pending: {},
		waiting: {},
		gapped: {},
		lanes: {},
		groupSizes: {},
		toolCalls: {},
		toolUseTimes: {},
		messageToolUses: {},
		toolSources: {},
		seenBlocks: {},
		compactions: {},
		summaries: {},
		skills: {},
		attached: [],
		agentToolUse: {},
		transcriptAgent: {},
		metaToolUse: {},
		responses: {},
		requestLogs: {},
		report: {
			unknownRecords: [],
			ignoredRecords: [],
			unreadable: []
		}
	};
}
// packages/engine/src/adapters/claude-code/wire.ts
/**
* The messages a `tail` hash may name, by Claude Code's hash rules: an `api-request-blob` row; a `user` row (role
* and content, a string prompt also as one text block); an assistant message, which is every `assistant` row of one
* `message.id`, in order; and a run of adjacent `user` rows joined into one message, found only when a tail asks
* for a hash that nothing else gives (so each run is hashed once per miss, not on every row).
*/
/** Assistant messages whose rows may still come, per transcript; older ones are closed. */
const MAX_OPEN_ASSISTANT = 8;
/** User rows the API may join into one message; a longer run keeps only its last rows. */
const MAX_USER_RUN = 16;
function wireHash(role, content) {
	return sha256Sorted({
		role,
		content
	});
}
function addBlob(store, data) {
	const hash = str(data.hash);
	const message = obj(data.message);
	if (hash === void 0 || message === void 0) return;
	store.putMessage(hash, {
		role: str(message.role) ?? "",
		content: blocksOf(message.content)
	});
}
function addUserRow(store, transcript, message) {
	const content = blocksOf(message.content);
	const role = str(message.role) ?? "user";
	store.putMessage(wireHash(role, message.content ?? null), {
		role,
		content
	});
	if (typeof message.content === "string") store.putMessage(wireHash(role, content), {
		role,
		content
	});
	transcript.userRun.push(content);
	if (transcript.userRun.length > MAX_USER_RUN) transcript.userRun.shift();
}
/** Add one row of an assistant message; returns the hash of the message so far. */
function addAssistantRow(store, transcript, message) {
	transcript.userRun = [];
	const id = str(message.id);
	if (id === void 0) return void 0;
	const known = get(store.state.assistantHashes, id);
	const content = [...get(store.state.assistant, id) ?? (known === void 0 ? void 0 : store.message(known)?.content) ?? [], ...arr(message.content) ?? []];
	transcript.openAssistantIds = [...transcript.openAssistantIds.filter((open) => open !== id), id];
	while (transcript.openAssistantIds.length > MAX_OPEN_ASSISTANT) {
		const done = transcript.openAssistantIds.shift() ?? "";
		delete store.state.assistant[done];
		delete store.state.assistantHashes[done];
	}
	put$1(store.state.assistant, id, content);
	const hash = wireHash("assistant", content);
	put$1(store.state.assistantHashes, id, hash);
	store.putMessage(hash, {
		role: "assistant",
		content
	});
	return hash;
}
/** The message a tail hash names; joins the transcript's current run of user rows when nothing else matches. */
function resolve$1(store, transcript, hash) {
	const known = store.message(hash);
	if (known !== void 0) return known;
	const run = transcript.userRun;
	for (let start = 0; start < run.length - 1; start++) {
		const content = run.slice(start).flat();
		if (wireHash("user", content) === hash) return store.putMessage(hash, {
			role: "user",
			content
		});
	}
}
/** Message content as blocks: a string is one text block. */
function blocksOf(content) {
	if (typeof content === "string") return [{
		type: "text",
		text: content
	}];
	return arr(content) ?? [];
}
/** Rows that can bring a missing part of a waiting request. */
const WIRE_ROWS = /* @__PURE__ */ new Set([
	"api-request-blob",
	"api-request-shape",
	"api-request",
	"user",
	"assistant"
]);
/** Calls kept waiting for a missing part; older ones stay unresolved. */
const MAX_WAITING = 32;
function createClaudeCodeParser(state = emptyState(), options = {}) {
	if (state.version !== 5) throw new Error(`a parser snapshot version ${String(state.version)} cannot be restored (this parser: 5)`);
	const estimator = options.estimator ?? estimateBlock;
	let changes = new Changes();
	const store = new Content(state, options.lookup ?? NO_LOOKUP, (record) => changes.records.set(record.key, record));
	const classifier = createClassifier(store, (block, unknownType) => {
		changes.blocks.push(block);
		if (unknownType !== void 0) countUnknown(changes.report, `content block ${unknownType}`);
	}, estimator);
	const read = (work) => {
		changes = new Changes();
		work();
		mergeReport(state.report, changes.report);
		return changes.delta(state);
	};
	const handler = (name) => new Rows(store, classifier, () => changes, name, estimator);
	return {
		push: (text, transcript = "main") => read(() => {
			const t = transcriptOf(state, transcript);
			const lines = (t.buffer + text).split("\n");
			t.buffer = lines.pop() ?? "";
			const rows = handler(transcript);
			for (const line of lines) rows.line(line);
		}),
		pushMeta: (transcript, text) => read(() => handler(transcript).meta(text)),
		flush: (transcript = "main") => read(() => {
			const t = transcriptOf(state, transcript);
			const line = t.buffer;
			t.buffer = "";
			if (line !== "") handler(transcript).line(line);
		}),
		snapshot: () => frontier(state)
	};
}
function transcriptOf(state, name) {
	return get(state.transcripts, name) ?? put$1(state.transcripts, name, {
		buffer: "",
		lines: 0,
		userRun: [],
		openAssistantIds: [],
		usageSinceCost: {}
	});
}
function mergeReport(total, delta) {
	total.unreadable.push(...delta.unreadable);
	total.unknownRecords = addCounts(total.unknownRecords, delta.unknownRecords);
	total.ignoredRecords = addCounts(total.ignoredRecords, delta.ignoredRecords);
}
/** The handlers of the rows of one transcript. */
var Rows = class {
	t;
	store;
	state;
	classifier;
	changes;
	name;
	estimator;
	constructor(store, classifier, changes, name, estimator) {
		this.store = store;
		this.state = store.state;
		this.classifier = classifier;
		this.changes = changes;
		this.name = name;
		this.estimator = estimator;
		this.t = transcriptOf(store.state, name);
	}
	line(text) {
		this.t.lines++;
		const row = readLine(`${this.name}:${this.t.lines}`, text, this.changes().report);
		if (row !== void 0) this.row(row);
	}
	meta(text) {
		let toolUseId;
		try {
			toolUseId = str(obj(JSON.parse(text))?.toolUseId);
		} catch (error) {
			this.changes().report.unreadable.push({
				at: `${this.name}.meta`,
				reason: `not JSON: ${error.message}`
			});
		}
		if (toolUseId === void 0) return;
		put$1(this.state.metaToolUse, this.name, toolUseId);
		this.linkChildren();
	}
	row(row) {
		this.handle(row);
		if (Object.keys(this.state.waiting).length > 0 && WIRE_ROWS.has(row.type)) this.recheck();
	}
	/** Remember a call whose request is not complete yet: a later row may still bring the missing part. */
	wait(id) {
		put$1(this.state.waiting, id, this.name);
		const ids = Object.keys(this.state.waiting);
		if (ids.length <= MAX_WAITING) return;
		const oldest = ids[0] ?? "";
		const spec = this.store.spec(oldest);
		const transcript = transcriptOf(this.state, get(this.state.waiting, oldest) ?? this.name);
		if (spec !== void 0 && !this.missing(spec, transcript).some((i) => i.kind === "unresolved-request")) {
			put$1(this.state.gapped, oldest, 1);
			this.recheck();
			return;
		}
		delete this.state.waiting[oldest];
		const call = this.store.call(oldest);
		if (call === void 0) return;
		call.issues.push({
			kind: "unresolved-request",
			detail: `stopped waiting after ${MAX_WAITING} newer incomplete calls`
		});
		this.changes().calls.add(oldest);
	}
	/** Check the waiting calls again, oldest first; a call whose request is now complete waits for, or gets, its split. */
	recheck() {
		const ids = Object.keys(this.state.waiting).flatMap((id) => this.store.call(id) ?? []).sort((a, b) => a.index - b.index);
		for (const call of ids) {
			const spec = this.store.spec(call.id);
			const transcript = get(this.state.waiting, call.id) ?? this.name;
			if (spec === void 0) continue;
			const missing = this.missing(spec, transcriptOf(this.state, transcript));
			if (this.blocked(call.id, missing)) continue;
			delete this.state.waiting[call.id];
			delete this.state.gapped[call.id];
			call.issues = [...call.issues.filter((i) => i.kind !== "unresolved-request" && i.kind !== "missing-message"), ...missing];
			this.changes().calls.add(call.id);
			if (call.usage === void 0) {
				call.issues.push({
					kind: "no-usage",
					detail: "the log has no response with usage for this call yet"
				});
				put$1(this.state.pending, call.id, 1);
			} else this.split(call, spec, call.usage);
		}
	}
	split(call, spec, usage) {
		const lane = laneOf(this.state, spec.lane, call.sessionId);
		if (lane.lastIndex !== void 0 && lane.lastIndex > call.index) {
			call.issues.push({
				kind: "unreconciled-tokens",
				detail: "the response came after a later call was split; not split"
			});
			return;
		}
		splitCall({
			store: this.store,
			classifier: this.classifier,
			changes: this.changes(),
			estimator: this.estimator
		}, call, spec, usage);
	}
	handle(row) {
		const session = this.session(row);
		const data = row.data;
		const message = obj(data.message);
		switch (row.type) {
			case "api-request-blob":
				addBlob(this.store, data);
				break;
			case "api-request-shape": {
				const hash = str(data.shapeHash);
				const shape = obj(data.shape);
				if (hash !== void 0 && shape !== void 0) this.store.putShape(hash, {
					system: arr(shape.system) ?? [],
					tools: arr(shape.tools) ?? []
				});
				break;
			}
			case "api-request":
				if (session !== void 0) this.request(row, session);
				this.t.userRun = [];
				break;
			case "assistant":
				if (message !== void 0) this.assistant(row, message, session);
				break;
			case "user":
				if (message !== void 0) this.user(row, message, session);
				break;
			case "system/compact_boundary":
				if (session !== void 0) this.compaction(row, session);
				break;
			case "cost-state":
				this.costState(data);
				break;
			case "attachment":
				this.attachment(data);
				break;
			case "ai-title":
			case "custom-title":
			case "agent-name":
				if (session !== void 0) this.naming(row, session);
				break;
			case "system/turn_duration":
				this.turnDuration(data);
				break;
			case "pr-link":
			case "continued-in":
			case "fork-context-ref":
			case "relocated":
			case "permission-mode":
			case "system/away_summary":
				this.event(row, session);
				break;
			default: countIgnored(this.changes().report, row.type);
		}
	}
	/**
	* The texts an attachment row says the harness rendered: a new Block that holds them gets them as its parts
	* when it is classified. A row that renders nothing holds nothing for the domain.
	*/
	attachment(data) {
		const attachment = obj(data.attachment);
		const texts = (arr(data.rendered) ?? []).flatMap((p) => str(obj(p)?.content) ?? []).filter((t) => t.trim() !== "");
		const type = str(attachment?.type);
		if (type === void 0 || texts.length === 0) {
			countIgnored(this.changes().report, "attachment");
			return;
		}
		const path = str(attachment?.filename) ?? str(attachment?.path);
		for (const text of texts) {
			const added = {
				type,
				text,
				transcript: this.name
			};
			if (path !== void 0) added.path = path;
			this.state.attached = remember(this.state.attached, added);
		}
	}
	/**
	* The attached texts of this transcript that no request checked yet must be in a message of this request; one
	* that is in none gets an issue on the Call, and is not looked for again. With a message missing, none is blamed;
	* nor is one that a newer attachment of its type replaced before the request (the harness sends the newest).
	* A type the harness often logs without sending it is counted in the report instead.
	*/
	locateAttached(call, spec, missing) {
		const open = this.state.attached.filter((a) => a.transcript === this.name && a.checked === void 0);
		if (open.length === 0) return;
		if (missing) {
			for (const a of open) a.checked = 1;
			return;
		}
		const texts = spec.tail.flatMap((hash) => (resolve$1(this.store, this.t, hash)?.content ?? []).flatMap((c) => str(obj(c)?.text) ?? []));
		const newest = new Map(open.map((a) => [a.type, a]));
		for (const a of open) if (texts.some((t) => holds(t, a)) || newest.get(a.type) !== a) a.checked = 1;
		else if (OFTEN_UNSENT.has(a.type)) {
			countIgnored(this.changes().report, `attachment ${a.type} (not sent)`);
			this.state.attached = this.state.attached.filter((x) => x !== a);
		} else {
			call.issues.push({
				kind: "unlocated-attachment",
				detail: `the ${a.type} attachment is in no message of the request`
			});
			this.state.attached = this.state.attached.filter((x) => x !== a);
		}
	}
	/** A title (the user's own wins over the harness's) or an agent name for the Session. */
	naming(row, session) {
		const before = JSON.stringify(session);
		const ai = str(row.data.aiTitle);
		const custom = str(row.data.customTitle);
		const agent = str(row.data.agentName);
		if (custom !== void 0) Object.assign(session, {
			title: custom,
			titleSource: "user"
		});
		else if (ai !== void 0 && session.titleSource !== "user") Object.assign(session, {
			title: ai,
			titleSource: "harness"
		});
		if (agent !== void 0) session.agentName = agent;
		if (JSON.stringify(session) !== before) this.changes().sessions.add(session.id);
	}
	/** The duration of a turn, on its last Call: the latest Call of the transcript. */
	turnDuration(data) {
		const ms = num$1(data.durationMs);
		const call = this.t.lastCallId === void 0 ? void 0 : this.store.call(this.t.lastCallId);
		if (ms === void 0 || call === void 0) return;
		call.turnDurationMs = ms;
		this.changes().calls.add(call.id);
	}
	/** An event on the Session's timeline. A row with no Session of its own belongs to its transcript's Session. */
	event(row, session) {
		const data = row.data;
		const parent = str(data.parentSessionId);
		const agent = str(data.agentId);
		const sessionId = session?.id ?? this.t.sessionId ?? (parent !== void 0 && agent !== void 0 ? `${parent}:agent-${agent}` : void 0);
		if (sessionId === void 0) return;
		const ts = str(data.timestamp) ?? get(this.state.sessions, sessionId)?.ended;
		const base = {
			id: row.at,
			sessionId,
			...ts === void 0 ? {} : { ts }
		};
		const event = (() => {
			switch (row.type) {
				case "pr-link": {
					const detail = {};
					if (data.prNumber !== void 0) detail.number = data.prNumber;
					if (data.prRepository !== void 0) detail.repository = data.prRepository;
					return {
						...base,
						kind: "pr",
						value: str(data.prUrl) ?? "",
						detail
					};
				}
				case "continued-in": return {
					...base,
					kind: "continued-in",
					value: str(data.continuedInSessionId) ?? ""
				};
				case "fork-context-ref": {
					const detail = {};
					if (data.contextLength !== void 0) detail.contextLength = data.contextLength;
					if (data.parentLastUuid !== void 0) detail.parentLastUuid = data.parentLastUuid;
					return {
						...base,
						kind: "forked-from",
						value: parent ?? "",
						detail
					};
				}
				case "relocated": return {
					...base,
					kind: "cwd",
					value: str(data.relocatedCwd) ?? ""
				};
				case "permission-mode": return {
					...base,
					kind: "mode",
					value: str(data.permissionMode) ?? ""
				};
				case "system/away_summary": return {
					...base,
					kind: "note",
					value: str(data.content) ?? ""
				};
				default: return;
			}
		})();
		if (event !== void 0) this.changes().events.push(event);
	}
	/** The Session of the row's transcript, created or updated with what the row tells. */
	session(row) {
		const parent = str(row.data.sessionId);
		if (parent === void 0) return void 0;
		const agent = str(row.data.agentId) ?? get(this.state.transcriptAgent, this.name);
		const isAgent = this.name !== "main" && agent !== void 0;
		if (isAgent && get(this.state.transcriptAgent, this.name) === void 0) {
			put$1(this.state.transcriptAgent, this.name, agent);
			this.linkChildren();
		}
		const id = isAgent ? `${parent}:agent-${agent}` : parent;
		this.t.sessionId = id;
		const existing = get(this.state.sessions, id);
		const session = existing ?? put$1(this.state.sessions, id, {
			id,
			harness: "claude-code",
			requestLog: "present"
		});
		const before = JSON.stringify(session);
		if (isAgent) session.parentId = parent;
		const version = str(row.data.version);
		const cwd = str(row.data.cwd);
		if (version !== void 0) session.harnessVersion ??= version;
		if (cwd !== void 0 && session.cwd === void 0) Object.assign(session, {
			project: cwd,
			cwd
		});
		const ts = str(row.data.timestamp);
		if (ts !== void 0) {
			if (session.started === void 0 || ts < session.started) session.started = ts;
			if (session.ended === void 0 || ts > session.ended) session.ended = ts;
		}
		if (existing === void 0 || JSON.stringify(session) !== before) this.changes().sessions.add(id);
		return session;
	}
	request(row, session) {
		const data = row.data;
		const id = str(data.id) ?? row.at;
		const params = obj(data.params) ?? {};
		const model = str(params.model) ?? "";
		const lane = `${model}|${str(data.querySource) ?? ""}`;
		const tail = (arr(data.tail) ?? []).filter((h) => typeof h === "string");
		const keep = num$1(data.keep) ?? 0;
		const spec = {
			sessionId: session.id,
			keep,
			tail,
			length: keep + tail.length,
			breakpoints: [],
			lane
		};
		const baseId = str(data.base);
		const shapeHash = str(data.shapeHash);
		if (baseId !== void 0) spec.baseId = baseId;
		if (shapeHash !== void 0) spec.shapeHash = shapeHash;
		spec.breakpoints = (arr(data.cacheControl) ?? []).flatMap((entry) => {
			const path = arr(obj(entry)?.path);
			return path === void 0 ? [] : [path.filter((p) => typeof p === "string" || typeof p === "number")];
		});
		this.store.putSpec(id, spec);
		const call = this.newCall(session.id, id, str(data.timestamp) ?? "", model, lane);
		this.requestLog(session, "r");
		call.params = paramsOf(params);
		if (shapeHash !== void 0) call.shapeHash = shapeHash;
		this.settle(spec);
		const missing = this.missing(spec);
		call.issues.push(...missing);
		this.locateAttached(call, spec, missing.length > 0);
		if (!this.blocked(id, missing)) {
			call.issues.push({
				kind: "no-usage",
				detail: "the log has no response with usage for this call yet"
			});
			put$1(this.state.pending, id, 1);
		} else this.wait(id);
		this.t.lastCallId = id;
	}
	newCall(sessionId, id, ts, model, lane) {
		const index = get(this.state.nextIndex, sessionId) ?? 0;
		put$1(this.state.nextIndex, sessionId, index + 1);
		const call = {
			id,
			sessionId,
			index,
			ts,
			model,
			lane,
			params: {},
			cacheBreakpoints: [],
			framingTokens: 0,
			issues: []
		};
		const canonical = canonicalModel(model);
		if (canonical !== void 0) call.canonicalModel = canonical;
		this.changes().calls.add(id);
		return put$1(this.state.calls, id, call);
	}
	/**
	* What of a request is not in the log. A missing base or shape is `unresolved-request`: the Call cannot be
	* split. A missing message is `missing-message`: once the Call stops waiting for it, a gap Block takes its place.
	*/
	missing(spec, transcript = this.t) {
		const missing = [];
		const unresolved = (detail) => missing.push({
			kind: "unresolved-request",
			detail
		});
		const base = spec.baseId === void 0 ? void 0 : this.store.spec(spec.baseId);
		if (spec.baseId !== void 0 && base === void 0) unresolved(`base call ${spec.baseId} is not in the log`);
		if (spec.keep > (base?.length ?? 0)) unresolved(`keep ${spec.keep} is more than the base call's messages`);
		if (spec.baseId !== void 0 && this.incomplete(spec.baseId)) unresolved(`base call ${spec.baseId} is incomplete`);
		if (spec.shapeHash === void 0 || this.store.shape(spec.shapeHash) === void 0) unresolved(`shape ${spec.shapeHash ?? "(none)"} is not in the log`);
		for (const hash of spec.tail) if (resolve$1(this.store, transcript, hash) === void 0) missing.push({
			kind: "missing-message",
			detail: `message ${hash} is not in the log`
		});
		return missing;
	}
	/** A base Call that cannot be split yet: part of its request is not resolved, or it still waits for a message. */
	incomplete(id) {
		if ((this.store.call(id)?.issues ?? []).some((i) => i.kind === "unresolved-request")) return true;
		return get(this.state.waiting, id) !== void 0 && get(this.state.gapped, id) === void 0;
	}
	/** The Call must wait: part of its request is unresolved, or it has missing messages it still waits for. */
	blocked(id, missing) {
		if (missing.some((i) => i.kind === "unresolved-request")) return true;
		return missing.length > 0 && get(this.state.gapped, id) === void 0;
	}
	/**
	* A new request in the lane (or one that builds on a waiting Call) means the log has moved on: Calls that wait
	* only for messages stop waiting, and are split with gap Blocks, so later Calls can build on them.
	*/
	settle(spec) {
		let settled = false;
		for (const [id, transcript] of Object.entries(this.state.waiting)) {
			const waiting = this.store.spec(id);
			if (waiting === void 0 || waiting.sessionId !== spec.sessionId) continue;
			if (waiting.lane !== spec.lane && id !== spec.baseId) continue;
			if (this.missing(waiting, transcriptOf(this.state, transcript)).some((i) => i.kind === "unresolved-request")) continue;
			put$1(this.state.gapped, id, 1);
			settled = true;
		}
		if (settled) this.recheck();
	}
	assistant(row, message, session) {
		const messageHash = addAssistantRow(this.store, this.t, message);
		const messageId = str(message.id) ?? "";
		const requestRef = str(row.data.requestRef);
		const raw = obj(message.usage);
		if (requestRef === void 0) {
			const usageOnly = session === void 0 || raw === void 0 ? void 0 : this.usageOnly(row, message, raw, session);
			if (session !== void 0) this.toolUses(row, message, messageId, usageOnly ?? "", session.id);
			const answered = usageOnly === void 0 ? void 0 : this.store.call(usageOnly);
			if (answered !== void 0) this.respond(answered, message, messageHash);
			return;
		}
		if (session !== void 0) this.toolUses(row, message, messageId, requestRef, session.id);
		const call = this.store.call(requestRef);
		if (call !== void 0) this.respond(call, message, messageHash);
		if (call === void 0 || raw === void 0) return;
		const usage = usageOf(raw);
		const known = get(this.state.responses, call.id);
		if (known?.messageId === messageId && messageHash !== void 0) known.hash = messageHash;
		if (call.usage !== void 0) {
			this.usageChanged(call, usage, raw);
			return;
		}
		setUsage(call, usage, raw);
		addUsage(this.t.usageSinceCost, call, usage);
		if (this.t.openCompaction !== void 0) addUsage(this.t.openCompaction.logged, call, usage);
		const response = {
			messageId,
			outputTokens: usage.outputTokens
		};
		if (messageHash !== void 0) response.hash = messageHash;
		if (usage.reasoningOutputTokens !== void 0) response.reasoningTokens = usage.reasoningOutputTokens;
		put$1(this.state.responses, call.id, response);
		const pending = get(this.state.pending, call.id);
		const spec = this.store.spec(call.id);
		if (pending !== void 0 && spec !== void 0) {
			delete this.state.pending[call.id];
			this.split(call, spec, usage);
		}
		this.changes().calls.add(call.id);
	}
	/**
	* The Call's Response: the Blocks of its assistant message so far (each row adds one), reported as Blocks now, so
	* the last answer of a Session has content too. The next request names the same Blocks by hash.
	*/
	respond(call, row, messageHash) {
		const refs = messageHash === void 0 ? void 0 : this.classifier.message(messageHash);
		const content = messageHash === void 0 ? void 0 : this.store.message(messageHash)?.content;
		if (refs === void 0 || content === void 0) return;
		const response = { blocks: refs.map((ref) => {
			const block = {
				hash: ref.hash,
				kind: ref.kind
			};
			const part = content[ref.contentIndex] ?? null;
			const reasoning = reasoningShown(part);
			if (reasoning !== void 0) block.reasoning = reasoning;
			const toolUseId = ref.kind === "tool-call" ? str(obj(part)?.id) : void 0;
			if (toolUseId !== void 0) block.toolUseId = toolUseId;
			return block;
		}) };
		const stopReason = str(row.stop_reason) ?? call.response?.stopReason;
		if (stopReason !== void 0) response.stopReason = stopReason;
		if (JSON.stringify(response) === JSON.stringify(call.response)) return;
		call.response = response;
		this.changes().calls.add(call.id);
	}
	/**
	* A response of a harness version that logs no requests: a usage-only Call, by message id, with exact usage
	* and cost but no Blocks. A reply the harness made itself (model `<synthetic>`) is no model Call. Returns its id.
	*/
	usageOnly(row, message, raw, session) {
		const model = str(message.model) ?? "";
		if (model === "<synthetic>") return void 0;
		const id = str(message.id) ?? row.at;
		const usage = usageOf(raw);
		const known = this.store.call(id);
		if (known !== void 0) {
			this.usageChanged(known, usage, raw);
			return id;
		}
		const call = this.newCall(session.id, id, str(row.data.timestamp) ?? "", model, `${model}|`);
		call.issues.push({
			kind: "no-request",
			detail: "the log holds no request for this call, only its usage"
		});
		setUsage(call, usage, raw);
		addUsage(this.t.usageSinceCost, call, usage);
		if (this.t.openCompaction !== void 0) addUsage(this.t.openCompaction.logged, call, usage);
		this.requestLog(session, "u");
		this.t.lastCallId = id;
		return id;
	}
	/** Note that a Session has a Call with a logged request (`r`) or a usage-only Call (`u`). */
	requestLog(session, kind) {
		const seen = get(this.state.requestLogs, session.id) ?? put$1(this.state.requestLogs, session.id, {});
		seen[kind] = 1;
		const status = seen.u === void 0 ? "present" : seen.r === void 0 ? "absent" : "partial";
		if (session.requestLog === status) return;
		session.requestLog = status;
		this.changes().sessions.add(session.id);
	}
	/**
	* A later row of the same response: keep the first input side and take the largest output side. A different
	* input side after the split is flagged (the split used the first); a change of the output only is not.
	*/
	usageChanged(call, next, raw) {
		const known = call.usage;
		if (known === void 0) return;
		const merged = mergeUsage(known, next);
		if (hasInput(known) && hasInput(next) && !sameInput(known, next) && call.blockCount !== void 0) {
			const detail = "usage changed after the call was split";
			if (!call.issues.some((i) => i.detail === detail)) call.issues.push({
				kind: "unreconciled-tokens",
				detail
			});
			this.changes().calls.add(call.id);
		}
		if (JSON.stringify(merged) === JSON.stringify(known)) return;
		const change = usageChange(known, merged);
		addUsage(this.t.usageSinceCost, call, change);
		if (this.t.openCompaction !== void 0) addUsage(this.t.openCompaction.logged, call, change);
		setUsage(call, merged, raw);
		const response = get(this.state.responses, call.id);
		if (response !== void 0) {
			response.outputTokens = merged.outputTokens;
			if (merged.reasoningOutputTokens === void 0) delete response.reasoningTokens;
			else response.reasoningTokens = merged.reasoningOutputTokens;
		}
		this.changes().calls.add(call.id);
	}
	toolUses(row, message, messageId, callId, sessionId) {
		for (const raw of arr(message.content) ?? []) {
			const block = obj(raw);
			if (block?.type !== "tool_use") continue;
			const id = str(block.id) ?? "";
			if (this.store.toolCall(id) !== void 0) continue;
			const name = str(block.name) ?? "";
			const input = block.input ?? null;
			const ids = [...get(this.state.messageToolUses, messageId) ?? [], id];
			put$1(this.state.messageToolUses, messageId, ids);
			const ts = str(row.data.timestamp);
			if (ts !== void 0) put$1(this.state.toolUseTimes, id, ts);
			const toolCall = {
				id,
				sessionId,
				callId,
				name,
				input,
				blockHash: blockHash("assistant", raw ?? null),
				source: toolSource(name, obj(input)),
				isError: false,
				parallel: 1
			};
			put$1(this.state.toolCalls, id, toolCall);
			for (const sibling of ids) {
				const t = this.store.toolCall(sibling);
				if (t === void 0) continue;
				t.parallel = ids.length;
				this.changes().toolCalls.add(sibling);
			}
			this.linkChildren();
		}
	}
	user(row, message, session) {
		addUserRow(this.store, this.t, message);
		const data = row.data;
		const texts = blocksOf(message.content).flatMap((b) => str(obj(b)?.text) ?? []);
		if (data.isCompactSummary === true) for (const text of texts) put$1(this.state.summaries, textHash(text), 1);
		const source = this.store.toolCall(str(data.sourceToolUseID) ?? "");
		const skill = str(obj(source?.input)?.skill);
		if (data.isMeta === true && source?.name === "Skill" && skill !== void 0) for (const text of texts) put$1(this.state.skills, textHash(text), skill);
		const ts = str(data.timestamp);
		for (const raw of blocksOf(message.content)) {
			const block = obj(raw);
			const id = str(block?.tool_use_id);
			const toolCall = id === void 0 || block?.type !== "tool_result" ? void 0 : this.store.toolCall(id);
			if (toolCall === void 0 || id === void 0) continue;
			toolCall.isError = block?.is_error === true;
			const started = get(this.state.toolUseTimes, id);
			const ms = started === void 0 || ts === void 0 ? NaN : Date.parse(ts) - Date.parse(started);
			if (!Number.isNaN(ms)) toolCall.durationMs = ms;
			this.changes().toolCalls.add(id);
		}
		const agentId = str(obj(data.toolUseResult)?.agentId);
		const toolUseId = str(obj(blocksOf(message.content)[0])?.tool_use_id);
		if (agentId !== void 0 && toolUseId !== void 0 && session !== void 0) {
			put$1(this.state.agentToolUse, agentId, toolUseId);
			this.link(toolUseId, `${session.id}:agent-${agentId}`);
		}
	}
	/** Link the tool calls that started subagents to their Sessions, from meta files and known agent ids. */
	linkChildren() {
		for (const [transcript, toolUseId] of Object.entries(this.state.metaToolUse)) {
			const agent = get(this.state.transcriptAgent, transcript);
			const parent = this.store.toolCall(toolUseId)?.sessionId;
			if (agent !== void 0 && parent !== void 0) this.link(toolUseId, `${parent}:agent-${agent}`);
		}
	}
	link(toolUseId, childSessionId) {
		const toolCall = this.store.toolCall(toolUseId);
		if (toolCall === void 0 || toolCall.childSessionId === childSessionId) return;
		toolCall.childSessionId = childSessionId;
		this.changes().toolCalls.add(toolUseId);
	}
	compaction(row, session) {
		const data = row.data;
		const id = str(data.uuid) ?? row.at;
		const meta = obj(data.compactMetadata);
		const ts = str(data.timestamp) ?? "";
		const compaction = {
			id,
			sessionId: session.id,
			ts,
			trigger: str(meta?.trigger) ?? ""
		};
		const before = num$1(meta?.preTokens);
		const after = num$1(meta?.postTokens);
		if (before !== void 0) compaction.beforeTokens = before;
		if (after !== void 0) compaction.afterTokens = after;
		if (this.t.lastCallId !== void 0) compaction.beforeCallId = this.t.lastCallId;
		const last = this.t.lastCallId === void 0 ? void 0 : this.store.call(this.t.lastCallId);
		const lane = last === void 0 ? void 0 : get(this.state.lanes, `${session.id}|${last.lane}`);
		if (lane !== void 0) delete lane.shapeKey;
		const summary = this.newCall(session.id, `${id}:summary`, ts, "", "compaction");
		summary.issues.push({
			kind: "unresolved-request",
			detail: "the summarising request is not in the log, only its derived usage"
		});
		compaction.summaryCallId = summary.id;
		put$1(this.state.compactions, id, compaction);
		this.changes().compactions.add(id);
		const open = {
			summaryCallId: summary.id,
			logged: structuredClone(this.t.usageSinceCost)
		};
		if (this.t.costTotals !== void 0) open.before = this.t.costTotals;
		if (before !== void 0) open.preTokens = before;
		this.t.openCompaction = open;
	}
	/** A running total: the summarising Call of an open compaction gets the change, less the Calls logged since. */
	costState(data) {
		const totals = obj(data.modelUsage) ?? {};
		const open = this.t.openCompaction;
		if (open !== void 0 && open.before !== void 0) {
			const call = this.store.call(open.summaryCallId);
			const derived = derivedUsage(open.before, totals, open.logged);
			if (call !== void 0 && derived !== void 0) {
				call.model = derived.model;
				const canonical = canonicalModel(derived.model);
				if (canonical !== void 0) call.canonicalModel = canonical;
				const input = derived.usage.inputTokens + derived.usage.cacheReadTokens + derived.usage.cacheWriteTokens;
				const negative = Object.values(derived.usage).some((v) => typeof v === "number" && v < 0);
				const limit = DERIVED_MARGIN * Math.max(open.preTokens ?? 0, MAX_CONTEXT_WINDOW);
				if (input <= 0 || negative) {
					const detail = `the running totals give an input of ${input} tokens for the summarising call; it has no usage`;
					call.issues.push({
						kind: "derived-usage-invalid",
						detail
					});
				} else if (input > limit) {
					const detail = `the running totals give an input of ${input} tokens for the summarising call, more than ${limit} (${DERIVED_MARGIN} × the larger of the context before the compaction and the largest context window); it has no usage`;
					call.issues.push({
						kind: "derived-usage-invalid",
						detail
					});
				} else setUsage(call, derived.usage);
				if (call.usage !== void 0 && open.preTokens !== void 0 && input < open.preTokens) {
					const detail = `derived input ${input} is less than the ${open.preTokens} tokens of context before the compaction`;
					call.issues.push({
						kind: "unreconciled-tokens",
						detail
					});
				}
				this.changes().calls.add(call.id);
			}
		}
		delete this.t.openCompaction;
		this.t.costTotals = totals;
		this.t.usageSinceCost = {};
	}
};
const COUNTERS = {
	inputTokens: "inputTokens",
	cacheReadTokens: "cacheReadInputTokens",
	cacheWriteTokens: "cacheCreationInputTokens",
	cacheWrite5mTokens: "cacheCreationEphemeral5mInputTokens",
	cacheWrite1hTokens: "cacheCreationEphemeral1hInputTokens",
	outputTokens: "outputTokens"
};
/** A derived input above this multiple of what one request can hold is not the summarising call's usage. */
const DERIVED_MARGIN = 1.5;
/** Add a Call's Usage to running sums per model, by the names of `cost-state`'s counters. */
function addUsage(sums, call, usage) {
	const model = call.canonicalModel ?? call.model;
	const sum = get(sums, model) ?? put$1(sums, model, {});
	for (const [field, key] of Object.entries(COUNTERS)) sum[key] = (sum[key] ?? 0) + (usage[field] ?? 0);
}
/**
* The usage of a summarising Call: the change of the running totals of the one model whose totals changed more
* than its logged Calls account for. A counter missing on either side stays unknown (a time-to-live split), not 0.
*/
function derivedUsage(before, after, logged) {
	const changed = Object.keys(after).flatMap((model) => {
		const a = obj(after[model]) ?? {};
		const b = obj(before[model]) ?? {};
		const sum = get(logged, canonicalModel(model) ?? model) ?? {};
		const usage = {
			basis: "derived",
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0
		};
		for (const [field, key] of Object.entries(COUNTERS)) {
			if (a[key] === void 0 || b[key] === void 0) continue;
			usage[field] = (num$1(a[key]) ?? 0) - (num$1(b[key]) ?? 0) - (sum[key] ?? 0);
		}
		return Object.keys(COUNTERS).some((field) => (usage[field] ?? 0) !== 0) ? [{
			model: model.replace(/\[[^\]]*\]$/, ""),
			usage
		}] : [];
	});
	return changed.length === 1 ? changed[0] : void 0;
}
/**
* The snapshot: only the open frontier. Content of the session so far (messages, shapes, requests, Blocks, closed
* Calls and ToolCalls, lane layouts) stays with the caller, who gives it back through the ContentLookup.
*/
function frontier(state) {
	const lanes = Object.values(state.lanes);
	const compactions = Object.values(state.transcripts).flatMap((t) => t.openCompaction?.summaryCallId ?? []);
	const calls = /* @__PURE__ */ new Set([
		...Object.keys(state.pending),
		...Object.keys(state.waiting),
		...lanes.flatMap((l) => l.lastCallId ?? []),
		...compactions
	]);
	const toolCalls = new Set(Object.values(state.toolCalls).flatMap((t) => t.resultBlockHash === void 0 ? [t.id] : []).slice(-64));
	const assistantIds = new Set(Object.values(state.transcripts).flatMap((t) => t.openAssistantIds));
	const pick = (record, keys) => {
		const out = {};
		for (const key of keys) {
			const value = get(record, key);
			if (value !== void 0) put$1(out, key, value);
		}
		return out;
	};
	return structuredClone({
		...state,
		messages: {},
		shapes: {},
		seenBlocks: {},
		groupSizes: {},
		toolSources: {},
		compactions: {},
		report: {
			unknownRecords: [],
			ignoredRecords: [],
			unreadable: []
		},
		gapped: pick(state.gapped, new Set(Object.keys(state.waiting))),
		specs: pick(state.specs, calls),
		calls: pick(state.calls, calls),
		responses: pick(state.responses, calls),
		toolCalls: pick(state.toolCalls, toolCalls),
		toolUseTimes: pick(state.toolUseTimes, toolCalls),
		messageToolUses: pick(state.messageToolUses, assistantIds),
		assistant: {},
		assistantHashes: pick(state.assistantHashes, assistantIds),
		lanes: Object.fromEntries(lanes.map((lane) => [`${lane.sessionId}|${lane.key}`, coldLane(lane)]))
	});
}
/** A lane without its layout: rebuilt from the caller's open runs when it is next used. */
function coldLane(lane) {
	const cold = {
		key: lane.key,
		sessionId: lane.sessionId,
		cold: true,
		shapeCount: lane.shapeCount,
		messages: [],
		messageEnds: [],
		blocks: [],
		sections: [],
		messageOf: [],
		contentOf: [],
		tokens: [],
		basis: [],
		group: [],
		estimates: [],
		prefix: [0],
		lone: [0],
		runs: [],
		reasoning: [],
		groupCount: {},
		partial: {},
		deferred: [],
		gaps: lane.gaps
	};
	if (lane.lastIndex !== void 0) cold.lastIndex = lane.lastIndex;
	if (lane.lastCallId !== void 0) cold.lastCallId = lane.lastCallId;
	if (lane.shapeKey !== void 0) cold.shapeKey = lane.shapeKey;
	return cold;
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
// packages/engine/src/ingest/discover.ts
/**
* Every log under `<root>/projects`, sorted by path, the folders that could not be read, and the symbolic links
* that were not followed. A missing projects folder is no error: there is nothing yet.
*/
async function discoverLogs(root) {
	const mains = /* @__PURE__ */ new Set();
	const errors = [];
	const links = [];
	const walk = async (dir) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT" && dir === join(root, "projects")) return;
			errors.push({
				path: dir,
				error: describe(error)
			});
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) mains.add(logOf(path));
			else if (entry.isSymbolicLink()) links.push(path);
		}
	};
	await walk(join(root, "projects"));
	const logs = [];
	for (const main of [...mains].sort()) {
		const found = await logFiles(main);
		logs.push(found.files);
		errors.push(...found.errors);
	}
	return {
		logs,
		errors,
		links
	};
}
/**
* The main transcript of the log a file belongs to: a file anywhere under `<session>/subagents/` (also a workflow's
* `subagents/workflows/<id>/`) belongs to `<session>.jsonl`.
*/
function logOf(path) {
	const parts = path.split(sep);
	const at = parts.lastIndexOf("subagents", parts.length - 2);
	return at > 0 ? `${parts.slice(0, at - 1).join(sep)}${sep}${parts[at - 1]}.jsonl` : path;
}
/**
* The files of the log of a main transcript, with the subagents that exist now, at any depth under its
* `subagents/` folder. A subagent's transcript name is its path below that folder, without `.jsonl`.
*/
async function logFiles(main) {
	const root = join(main.replace(/\.jsonl$/, ""), "subagents");
	const subagents = [];
	const errors = [];
	const walk = async (dir) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			const code = error.code;
			if (dir === root && (code === "ENOENT" || code === "ENOTDIR")) return;
			errors.push({
				path: dir,
				error: describe(error)
			});
			return;
		}
		const names = new Set(entries.map((e) => e.name));
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const name = relative(root, path).split(sep).join("/").replace(/\.jsonl$/, "");
				const meta = entry.name.replace(/\.jsonl$/, ".meta.json");
				const file = {
					path,
					name
				};
				if (names.has(meta)) file.meta = join(dir, meta);
				subagents.push(file);
			}
		}
	};
	await walk(root);
	subagents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return {
		files: {
			main,
			subagents
		},
		errors
	};
}
/** An error as one line: its code and message. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
// packages/engine/src/ingest/files.ts
/**
* Read transcript files: only ever opened read-only, read from a byte offset in bounded batches that end at a
* newline. Bytes after the last newline (a line still being written) are left for the next read, so a line, and
* a multi-byte character in it, is never cut.
*/
async function statOf(handle) {
	const s = await handle.stat({ bigint: true });
	return {
		fileId: `${s.dev}:${s.ino}`,
		size: Number(s.size),
		mtimeMs: Number(s.mtimeMs)
	};
}
const HEAD_BYTES = 4096;
const TAIL_BYTES = 1024;
/** A hash of the first bytes of the file and of the bytes just before `offset`: it changes when the file is rewritten. */
async function fingerprint(handle, offset) {
	const head = await readAt(handle, 0, Math.min(HEAD_BYTES, offset));
	const tailStart = Math.max(0, offset - TAIL_BYTES);
	const tail = await readAt(handle, tailStart, offset - tailStart);
	return createHash("sha256").update(head).update(tail).digest("hex").slice(0, 32);
}
async function readAt(handle, position, length) {
	const buffer = Buffer.alloc(length);
	let done = 0;
	while (done < length) {
		const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
		if (bytesRead === 0) break;
		done += bytesRead;
	}
	return buffer.subarray(0, done);
}
/**
* The complete lines from `offset` to `size`, in pieces of about `batchBytes` that each end with a newline, with
* the offset after each piece. A line longer than a batch is read whole, up to `maxLineBytes`; a longer one is
* skipped (only its end is looked for) and given as `skipped`. A last line without a newline is not given.
*/
async function* completeLines(handle, offset, size, batchBytes, maxLineBytes = Number.POSITIVE_INFINITY) {
	let position = offset;
	while (position < size) {
		const batch = typeof batchBytes === "function" ? batchBytes() : batchBytes;
		let length = Math.min(batch, size - position);
		let buffer = await readAt(handle, position, length);
		let newline = buffer.lastIndexOf(10);
		while (newline < 0 && position + length < size && length < maxLineBytes) {
			length = Math.min(length * 2, size - position, maxLineBytes);
			buffer = await readAt(handle, position, length);
			newline = buffer.lastIndexOf(10);
		}
		if (newline < 0 && length >= maxLineBytes && position + length < size) {
			const end = await nextNewline(handle, position + length, size, batch);
			if (end === void 0) return;
			yield {
				skipped: end - position,
				start: position,
				end
			};
			position = end;
			continue;
		}
		if (newline < 0) return;
		const end = position + newline + 1;
		yield {
			text: buffer.subarray(0, newline + 1).toString("utf8"),
			end
		};
		position = end;
	}
}
/** The offset after the next newline at or after `from`, read in chunks; undefined when there is none yet. */
async function nextNewline(handle, from, size, chunk) {
	for (let at = from; at < size; at += chunk) {
		const newline = (await readAt(handle, at, Math.min(chunk, size - at))).indexOf(10);
		if (newline >= 0) return at + newline + 1;
	}
}
// packages/engine/src/ingest/memory.ts
/** Bring the store's memory documents up to date with the files. */
async function ingestMemory(root, store) {
	const errors = [];
	const projects = await entries(join(root, "projects"), errors);
	const stored = new Map(store.memory.marks().map((m) => [`${m.projectDir}\0${m.path}`, m]));
	const put = [];
	const seen = /* @__PURE__ */ new Set();
	for (const project of projects.filter((e) => e.isDirectory())) {
		const projectDir = join(root, "projects", project.name);
		const folder = join(projectDir, "memory");
		for (const file of await entries(folder, errors, true)) {
			if (!file.isFile() || !file.name.endsWith(".md")) continue;
			const key = `${projectDir}\0${file.name}`;
			const path = join(folder, file.name);
			seen.add(key);
			try {
				const s = await stat(path);
				const old = stored.get(key);
				if (old !== void 0 && old.size === s.size && old.mtimeMs === s.mtimeMs) continue;
				const content = await readFile(path, "utf8");
				put.push({
					projectDir,
					path: file.name,
					content,
					mtimeMs: s.mtimeMs,
					size: s.size
				});
			} catch (error) {
				errors.push({
					path,
					error: describe(error)
				});
			}
		}
	}
	const mine = (m) => dirname(m.projectDir) === join(root, "projects");
	const remove = [...stored.entries()].filter(([key, m]) => mine(m) && !seen.has(key)).map(([, m]) => m);
	if (put.length === 0 && remove.length === 0) return { errors };
	return {
		errors,
		changed: {
			cursor: store.memory.write({
				put,
				remove
			}),
			projectDirs: [...new Set([...put, ...remove].map((d) => d.projectDir))].sort()
		}
	};
}
/** The entries of a folder; a missing one is empty (no projects yet, no memory folder). */
async function entries(dir, errors, optional = false) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || optional && code === "ENOTDIR") return [];
		errors.push({
			path: dir,
			error: describe(error)
		});
		return [];
	}
}
// packages/engine/src/ingest/ingest.ts
const HARNESS = "claude-code";
/** Logs whose parser stays in memory between passes (live sessions); others are restored from their snapshot. */
const MAX_WARM_LOGS = 8;
function createIngest(options) {
	const { store, root } = options;
	const codec = options.codec ?? claudeCodeCodec;
	const limits = {
		batchBytes: options.batchBytes ?? 4194304,
		batchMs: options.batchMs ?? 40,
		restoreBytes: options.restoreBytes ?? 67108864,
		maxLineBytes: options.maxLineBytes ?? 67108864
	};
	const listeners = /* @__PURE__ */ new Set();
	const progressListeners = /* @__PURE__ */ new Set();
	let progress;
	const told = () => {
		if (progress === void 0) return;
		const now = { ...progress };
		for (const listener of progressListeners) listener(now);
	};
	/** The parsers of the logs read last, oldest first: a live log is read on without a restore. */
	const warmParsers = /* @__PURE__ */ new Map();
	let queue = Promise.resolve();
	/** One pass at a time: two passes over one log would read its new bytes twice. */
	const serial = (work) => {
		const next = queue.then(work);
		queue = next.catch(() => void 0);
		return next;
	};
	/** Tell the listeners; one that throws is reported in the errors (once per path), and the others still run. */
	const tell = (event, path, errors) => {
		for (const listener of listeners) try {
			listener(event);
		} catch (error) {
			const failure = {
				path,
				error: `a Calls listener failed: ${describe(error)}`
			};
			if (!errors.some((e) => e.path === failure.path && e.error === failure.error)) errors.push(failure);
		}
	};
	/** One event per Session the write changed: with no Calls listed when only the Session itself changed. */
	const emit = (log, result, summary) => {
		const byId = new Map(result.calls.map((c) => [c.sessionId, c]));
		for (const sessionId of /* @__PURE__ */ new Set([...result.calls.map((c) => c.sessionId), ...result.sessions])) {
			const { added = [], addedIndexes = [], updated = [] } = byId.get(sessionId) ?? {};
			const event = {
				kind: "calls",
				logId: result.log,
				cursor: result.cursor,
				sessionId,
				added,
				addedIndexes,
				updated
			};
			tell(event, log, summary.errors);
		}
	};
	const memoryPass = async (errors) => {
		const done = await ingestMemory(root, store);
		if (done.changed !== void 0) tell({
			kind: "memory",
			...done.changed
		}, root, errors);
		return done.errors;
	};
	const pass = async (logs, errors, signal) => {
		const summary = {
			logs: logs.length,
			files: 0,
			bytes: 0,
			callsAdded: 0,
			errors: [...errors],
			stopped: false
		};
		const current = {
			logsDone: 0,
			logsTotal: logs.length,
			bytesDone: 0,
			bytesTotal: await newBytes(logs, store.fileOffsets()),
			startedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		progress = current;
		const step = () => {
			current.bytesDone = summary.bytes;
			current.bytesTotal = Math.max(current.bytesTotal, summary.bytes);
			told();
		};
		for (const files of logs) {
			const log = store.log(files.main, HARNESS, codec);
			try {
				if (signal?.aborted) {
					summary.stopped = true;
					break;
				}
				const warm = warmParsers.get(files.main) ?? { sinceRestore: 0 };
				warmParsers.delete(files.main);
				if (log.emptied !== void 0) tell({
					kind: "log-removed",
					logId: log.id,
					...log.emptied
				}, files.main, summary.errors);
				const removed = (event) => tell(event, files.main, summary.errors);
				const emitted = (result) => {
					emit(files.main, result, summary);
					step();
				};
				await ingestLog(log, files, limits, summary, emitted, signal, warm, removed);
				if (warm.parser !== void 0) warmParsers.set(files.main, warm);
				for (const old of warmParsers.keys()) {
					if (warmParsers.size <= MAX_WARM_LOGS) break;
					warmParsers.delete(old);
				}
			} catch (error) {
				summary.errors.push({
					path: files.main,
					error: `ingest failed: ${describe(error)}`
				});
				markFailed(log, files.main, describe(error));
			}
			current.logsDone++;
			step();
		}
		return summary;
	};
	return {
		ingestAll: (run = {}) => serial(async () => {
			const found = await discoverLogs(root);
			const listenerErrors = [];
			const memory = [...await memoryPass(listenerErrors), ...listenerErrors];
			const within = (path) => found.errors.some((e) => path === e.path || path.startsWith(e.path + sep));
			const errors = [...found.errors, ...memory.filter((m) => !within(m.path))];
			store.setScanIssues([...errors.map((e) => ({
				path: e.path,
				issue: e.error
			})), ...found.links.map((path) => ({
				path,
				issue: "a symbolic link; not followed"
			}))]);
			return pass(found.logs, errors, run.signal);
		}),
		ingestPaths: (paths, run = {}) => serial(async () => {
			const logs = [];
			const errors = [];
			for (const main of new Set(paths.map(logOf))) {
				const found = await logFiles(main);
				logs.push(found.files);
				errors.push(...found.errors);
			}
			return pass(logs, errors, run.signal);
		}),
		ingestMemory: () => serial(async () => {
			const errors = [];
			return [...await memoryPass(errors), ...errors];
		}),
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		progress: () => progress === void 0 ? void 0 : { ...progress },
		onProgress(listener) {
			progressListeners.add(listener);
			return () => progressListeners.delete(listener);
		},
		onCalls(listener) {
			const calls = (event) => {
				if (event.kind === "calls" && (event.added.length > 0 || event.updated.length > 0)) listener(event);
			};
			listeners.add(calls);
			return () => listeners.delete(calls);
		}
	};
}
/** The smallest batch, and the time one batch should take: the event loop is blocked for about that long. */
const MIN_BATCH_BYTES = 65536;
/**
* Batch sizes bounded by time as well as bytes: after each batch the next is sized so it takes about `batchMs`
* (parse and write), between `MIN_BATCH_BYTES` and `batchBytes`. It starts small.
*/
function batchBudget(limits) {
	const max = limits.batchBytes;
	const min = Math.min(MIN_BATCH_BYTES, max);
	const budget = {
		bytes: Math.min(262144, max),
		took(bytes, ms) {
			if (bytes <= 0) return;
			const next = ms <= 0 ? max : bytes * limits.batchMs / ms;
			budget.bytes = Math.round(Math.max(min, Math.min(max, next)));
		}
	};
	return budget;
}
/** The bytes of these logs' files beyond what the store has read: what a pass will read (a file gone counts 0). */
async function newBytes(logs, offsets) {
	let total = 0;
	for (const files of logs) {
		const paths = [files.main, ...files.subagents.flatMap((a) => a.meta === void 0 ? [a.path] : [a.path, a.meta])];
		for (const path of paths) try {
			total += Math.max(0, (await stat(path)).size - (offsets.get(path) ?? 0));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return total;
}
async function ingestLog(log, files, limits, summary, emit, signal, warm, removed) {
	const entries = [{
		path: files.main,
		transcript: "main",
		kind: "transcript"
	}];
	for (const agent of files.subagents) {
		if (agent.meta !== void 0) entries.push({
			path: agent.meta,
			transcript: agent.name,
			kind: "meta"
		});
		entries.push({
			path: agent.path,
			transcript: agent.name,
			kind: "transcript"
		});
	}
	const budget = batchBudget(limits);
	try {
		for (const entry of entries) await openEntry(entry);
		let marks = new Map(log.files().map((m) => [m.path, m]));
		if (await anyReplaced(entries, marks)) {
			removed({
				kind: "log-removed",
				logId: log.id,
				cursor: log.reset()
			});
			marks = /* @__PURE__ */ new Map();
			delete warm.parser;
			warm.sinceRestore = 0;
		}
		let snapshot = log.snapshot();
		const parserNow = () => warm.parser ??= createClaudeCodeParser(snapshot, { lookup: log.lookup });
		/**
		* Write one delta with its mark and snapshot. After `restoreBytes` of input, drop the parser: the next one is
		* restored from the snapshot and the store, so the memory of a long file stays bounded.
		*/
		const write = (delta, mark, bytes = 0) => {
			if (delta !== void 0 && warm.parser !== void 0) snapshot = warm.parser.snapshot();
			const result = log.write({
				deltas: delta === void 0 ? [] : [delta],
				files: [mark],
				...delta === void 0 || snapshot === void 0 ? {} : { snapshot }
			});
			warm.sinceRestore += bytes;
			if (warm.sinceRestore >= limits.restoreBytes) {
				delete warm.parser;
				warm.sinceRestore = 0;
			}
			marks.set(mark.path, mark);
			summary.callsAdded += result.calls.reduce((n, c) => n + c.added.length, 0);
			emit(result);
		};
		for (const entry of entries) {
			const old = marks.get(entry.path);
			if (entry.handle === void 0 || entry.stat === void 0) {
				const error = entry.error ?? "not readable";
				summary.errors.push({
					path: entry.path,
					error
				});
				if (old?.error !== error) write(void 0, {
					...base(entry, old),
					error
				});
				continue;
			}
			const stat = entry.stat;
			const mark = (offset, print) => {
				const m = {
					...base(entry, old),
					fileId: stat.fileId,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					offset
				};
				if (print !== void 0) m.fingerprint = print;
				return m;
			};
			if (old !== void 0 && old.error === void 0 && unchanged(old, stat)) continue;
			if (entry.kind === "meta") {
				if (old !== void 0 && old.error === void 0) continue;
				const text = await readFile(entry.handle, "utf8");
				write(parserNow().pushMeta(entry.transcript, text), mark(stat.size));
				summary.files++;
				summary.bytes += stat.size;
				continue;
			}
			let offset = old?.offset ?? 0;
			let print = old?.fingerprint;
			let read = false;
			const pieces = completeLines(entry.handle, offset, stat.size, () => budget.bytes, limits.maxLineBytes);
			for await (const piece of pieces) {
				if (signal?.aborted) break;
				const started = performance.now();
				const delta = parserNow().push("text" in piece ? piece.text : "\n", entry.transcript);
				if ("skipped" in piece) {
					const reason = `line is longer than ${limits.maxLineBytes} bytes; skipped`;
					delta.report.unreadable.push({
						at: `${entry.transcript}@${piece.start}`,
						reason
					});
				}
				const bytes = piece.end - offset;
				summary.bytes += bytes;
				offset = piece.end;
				read = true;
				print = await fingerprint(entry.handle, offset);
				write(delta, {
					...mark(offset, print),
					size: offset
				}, bytes);
				budget.took(bytes, performance.now() - started);
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (read) summary.files++;
			if (signal?.aborted) {
				summary.stopped = true;
				return;
			}
			write(void 0, mark(offset, print));
		}
	} finally {
		for (const entry of entries) await entry.handle?.close();
	}
}
async function openEntry(entry) {
	try {
		entry.handle = await open(entry.path, "r");
		entry.stat = await statOf(entry.handle);
	} catch (error) {
		entry.error = describe(error);
	}
}
/** A file of the log was replaced, cut below its read position, or rewritten: the log must be read again. */
async function anyReplaced(entries, marks) {
	for (const { path, handle, stat, kind } of entries) {
		const old = marks.get(path);
		if (handle === void 0 || stat === void 0 || old?.fileId === void 0 || unchanged(old, stat)) continue;
		if (old.fileId !== stat.fileId || stat.size < old.offset) return true;
		if (kind === "meta" && stat.size !== old.size) return true;
		if (kind === "transcript" && old.offset > 0 && await fingerprint(handle, old.offset) !== old.fingerprint) return true;
	}
	return false;
}
function unchanged(mark, stat) {
	return mark.fileId === stat.fileId && mark.size === stat.size && mark.mtimeMs === stat.mtimeMs;
}
/** The mark of an entry, keeping what an earlier mark knew, without the error. */
function base(entry, old) {
	const { error: _, ...rest } = old ?? {
		size: 0,
		offset: 0
	};
	return {
		...rest,
		path: entry.path,
		transcript: entry.transcript,
		kind: entry.kind
	};
}
/** Keep the failure of a log's ingest in the store's report, on its main transcript. */
function markFailed(log, path, error) {
	const old = log.files().find((m) => m.path === path);
	log.write({
		deltas: [],
		files: [{
			...old ?? {
				path,
				transcript: "main",
				kind: "transcript",
				size: 0,
				offset: 0
			},
			error: `ingest failed: ${error}`
		}]
	});
}
// packages/engine/src/ingest/paths.ts
/** Where Claude Code keeps its transcripts. */
/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, as Claude Code itself decides. */
function claudeConfigDir(env, home) {
	const dir = env.CLAUDE_CONFIG_DIR;
	return dir !== void 0 && dir !== "" ? dir : join(home, ".claude");
}
// packages/engine/src/ingest/watch.ts
const isTranscriptFile = (path) => path.endsWith(".jsonl") || path.endsWith(".meta.json");
/** A project's memory document: `<root>/projects/<project>/memory/<name>.md`. */
const isMemoryFile = (path) => path.endsWith(".md") && basename(dirname(path)) === "memory";
function watchTranscripts(options) {
	const { ingest } = options;
	const debounceMs = options.debounceMs ?? 100;
	const onError = options.onError ?? ((error) => console.error("quantext: live ingest failed:", error));
	let paths = /* @__PURE__ */ new Set();
	let everything = false;
	let memory = false;
	let timer;
	let stopped = false;
	let running = Promise.resolve();
	const stopping = new AbortController();
	const run = { signal: stopping.signal };
	/** Take the changes gathered so far, and read them after the read in progress. */
	const read = () => {
		if (!everything && !memory && paths.size === 0) return running;
		const asked = [...paths];
		const all = everything;
		const notes = memory && !all;
		paths = /* @__PURE__ */ new Set();
		everything = false;
		memory = false;
		running = running.then(async () => {
			try {
				if (all) await ingest.ingestAll(run);
				else if (asked.length > 0) await ingest.ingestPaths(asked, run);
				if (notes) for (const e of await ingest.ingestMemory()) onError(/* @__PURE__ */ new Error(`${e.path}: ${e.error}`));
			} catch (error) {
				onError(error);
			}
		});
		return running;
	};
	const onChange = (path) => {
		if (stopped) return;
		if (path !== void 0 && isTranscriptFile(path)) paths.add(path);
		else if (path !== void 0 && isMemoryFile(path)) memory = true;
		else if (path !== void 0 && extname(path) !== "") return;
		else everything = true;
		timer ??= setTimeout(() => {
			timer = void 0;
			read();
		}, debounceMs);
	};
	const source = (options.changes ?? fsChanges(options.root)).start(onChange);
	return {
		flush() {
			clearTimeout(timer);
			timer = void 0;
			return read();
		},
		async stop() {
			stopped = true;
			stopping.abort();
			clearTimeout(timer);
			timer = void 0;
			source.close();
			await running;
		}
	};
}
/**
* Changes under `<root>/projects` from `fs.watch` (recursive). While the folder cannot be watched (it does not
* exist yet, or the platform refuses), poll instead, and try to watch again on each poll.
*/
function fsChanges(root, options = {}) {
	const pollMs = options.pollMs ?? 2e3;
	const safetyPollMs = options.safetyPollMs ?? 3e4;
	const projects = join(root, "projects");
	return { start(onChange) {
		let watcher;
		let poll;
		const startPolling = () => {
			poll ??= setInterval(() => {
				onChange(void 0);
				if (tryWatch()) {
					clearInterval(poll);
					poll = void 0;
				}
			}, pollMs);
		};
		const tryWatch = () => {
			try {
				watcher = watch(projects, { recursive: true }, (_event, name) => onChange(name === null ? void 0 : join(projects, String(name))));
			} catch {
				return false;
			}
			watcher.on("error", () => {
				watcher?.close();
				watcher = void 0;
				onChange(void 0);
				startPolling();
			});
			onChange(void 0);
			return true;
		};
		if (!tryWatch()) startPolling();
		const safety = safetyPollMs > 0 ? setInterval(() => onChange(void 0), safetyPollMs) : void 0;
		return { close() {
			watcher?.close();
			clearInterval(poll);
			clearInterval(safety);
		} };
	} };
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
	return process.versions.bun === void 0 ? (await import("./engine-node-driver.js")).openNode(path, options) : (await import("./engine-bun-driver.js")).openBun(path, options);
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
/** Open (or create) the database file with the runtime's built-in SQLite: WAL, foreign keys, a busy timeout. */
async function openDriver(path) {
	const raw = await openRaw(path);
	raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	raw.exec("PRAGMA journal_mode = WAL");
	raw.exec("PRAGMA synchronous = NORMAL");
	raw.exec("PRAGMA foreign_keys = ON");
	return withTransactions(raw);
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
// packages/engine/src/store/lock.ts
/**
* The writer lock, so that two engines never write one database. It is an OS file lock: a small SQLite database
* held in an exclusive transaction for as long as the store is open. The OS releases it when the process ends,
* also when it is killed, so there is no stale lock and no pid check. The pid file only tells who holds it.
*/
var StoreLockedError = class extends Error {
	/** The holder's pid, as its pid file says; undefined when the file is missing or unreadable. */
	pid;
	constructor(path, pid) {
		super(`another engine${pid === void 0 ? "" : ` (pid ${pid})`} writes this store: ${path}`);
		this.name = "StoreLockedError";
		this.pid = pid;
	}
};
/** Take the lock at `path` (the pid goes to `pidPath`), or throw StoreLockedError while another process holds it. */
async function acquireLock(path, pidPath) {
	let db;
	try {
		db = await hold(path, pidPath);
	} catch (error) {
		if (!/not a database/.test(String(error))) throw error;
		rmSync(path, { force: true });
		db = await hold(path, pidPath);
	}
	writeFileSync(pidPath, String(process.pid), { mode: 384 });
	return { release() {
		rmSync(pidPath, { force: true });
		db.exec("ROLLBACK");
		db.close();
	} };
}
/**
* Make a database file the user's alone before SQLite opens it: SQLite gives its journal, WAL and shared-memory
* files the mode of their database. A missing file is made empty (an empty file is an empty database).
*/
function privateFile(path) {
	if (process.platform === "win32") return;
	if (existsSync(path)) chmodSync(path, 384);
	else writeFileSync(path, "", { mode: 384 });
}
async function hold(path, pidPath) {
	privateFile(path);
	const db = await openRaw(path);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("PRAGMA locking_mode = EXCLUSIVE");
		db.exec("BEGIN EXCLUSIVE");
		return db;
	} catch (error) {
		db.close();
		if (/database is locked|SQLITE_BUSY/.test(String(error))) throw new StoreLockedError(path, holderPid(pidPath));
		throw error;
	}
}
function holderPid(pidPath) {
	try {
		const pid = Number(readFileSync(pidPath, "utf8"));
		return Number.isInteger(pid) && pid > 0 ? pid : void 0;
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
}
// packages/engine/src/store/schema.ts
/** Migration i (0-based) takes the schema from version i to version i + 1. */
const MIGRATIONS = [
	`
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  adapter_version INTEGER NOT NULL,
  snapshot TEXT
) STRICT;

CREATE TABLE ingest_files (
  path TEXT PRIMARY KEY,
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  transcript TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transcript', 'meta')),
  file_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  error TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX ingest_files_log ON ingest_files (log);

CREATE TABLE sessions (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  harness TEXT NOT NULL,
  harness_version TEXT,
  project TEXT,
  cwd TEXT,
  started TEXT,
  ended TEXT,
  request_log TEXT NOT NULL CHECK (request_log IN ('present', 'partial', 'absent')),
  title TEXT,
  title_source TEXT,
  agent_name TEXT,
  PRIMARY KEY (log, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE calls (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  lane TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  canonical_model TEXT,
  params TEXT NOT NULL,
  shape_hash TEXT,
  usage_basis TEXT,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  speed TEXT,
  service_tier TEXT,
  inference_geo TEXT,
  cost_input_usd REAL,
  cost_cache_read_usd REAL,
  cost_cache_write_usd REAL,
  cost_output_usd REAL,
  cost_total_usd REAL,
  price_model TEXT,
  price_source TEXT,
  price_date TEXT,
  price_modifiers TEXT,
  block_count INTEGER,
  cache_breakpoints TEXT NOT NULL,
  cache_boundary_tokens INTEGER,
  cache_boundary_position INTEGER,
  framing_tokens INTEGER NOT NULL,
  issues TEXT NOT NULL,
  turn_duration_ms INTEGER,
  PRIMARY KEY (log, id),
  FOREIGN KEY (log, session_id) REFERENCES sessions (log, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX calls_session ON calls (log, session_id, idx);

CREATE TABLE blocks (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
) STRICT;

CREATE TABLE media (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL
) STRICT;

CREATE TABLE log_blocks (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  hash TEXT NOT NULL REFERENCES blocks (hash),
  kind TEXT NOT NULL,
  tool TEXT,
  file_path TEXT,
  mcp_server TEXT,
  skill TEXT,
  attachment TEXT,
  PRIMARY KEY (log, hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE call_blocks (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  block_hash TEXT NOT NULL REFERENCES blocks (hash),
  position INTEGER NOT NULL,
  section TEXT NOT NULL,
  message INTEGER,
  tokens INTEGER,
  basis TEXT,
  grp TEXT,
  first_call INTEGER NOT NULL,
  last_call INTEGER,
  PRIMARY KEY (log, session_id, lane, first_call, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX call_blocks_block ON call_blocks (block_hash);

CREATE TABLE tool_calls (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT,
  block_hash TEXT,
  tool TEXT,
  file_path TEXT,
  mcp_server TEXT,
  skill TEXT,
  attachment TEXT,
  result_block_hash TEXT,
  is_error INTEGER NOT NULL,
  duration_ms REAL,
  parallel INTEGER NOT NULL,
  child_session_id TEXT,
  PRIMARY KEY (log, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX tool_calls_call ON tool_calls (log, call_id);

CREATE TABLE compactions (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  trigger TEXT NOT NULL,
  before_tokens INTEGER,
  after_tokens INTEGER,
  before_call_id TEXT,
  summary_call_id TEXT,
  PRIMARY KEY (log, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE messages (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  role TEXT NOT NULL,
  blocks TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE shapes (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  tools TEXT NOT NULL,
  system TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE records (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (log, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE session_events (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts TEXT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (log, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX session_events_session ON session_events (log, session_id, ts);

CREATE TABLE report_kinds (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'ignored')),
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (log, status, kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE scan_issues (
  path TEXT PRIMARY KEY,
  issue TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE report_unreadable (
  log INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (log, seq)
) STRICT, WITHOUT ROWID;
`,
	`
CREATE TABLE project_memory (
  project_dir TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (project_dir, path)
) STRICT, WITHOUT ROWID;

CREATE INDEX calls_lane ON calls (log, session_id, lane, idx, usage_basis, cache_boundary_position,
  cache_read_tokens, cache_write_tokens, input_tokens, cost_cache_read_usd, cost_cache_write_usd, cost_input_usd);
`,
	`
ALTER TABLE calls ADD COLUMN cache_boundary_offset INTEGER;
UPDATE calls SET cache_boundary_offset = (
  SELECT coalesce(sum(r.tokens), 0) FROM call_blocks r
  WHERE r.log = calls.log AND r.session_id = calls.session_id AND r.lane = calls.lane AND r.first_call <= calls.idx
    AND (r.last_call IS NULL OR r.last_call >= calls.idx) AND r.position < calls.cache_boundary_position)
WHERE cache_boundary_position IS NOT NULL;
ALTER TABLE calls ADD COLUMN unit_read_usd REAL;
ALTER TABLE calls ADD COLUMN unit_rest_usd REAL;
UPDATE calls SET unit_read_usd = CASE WHEN cache_read_tokens > 0 THEN cost_cache_read_usd / cache_read_tokens END,
  unit_rest_usd = CASE WHEN cache_write_tokens > 0 THEN cost_cache_write_usd / cache_write_tokens
    WHEN input_tokens > 0 THEN cost_input_usd / input_tokens END;
DROP INDEX calls_lane;
CREATE INDEX calls_lane ON calls (log, session_id, lane, idx, cache_boundary_position, cache_boundary_offset,
  cache_read_tokens, cache_write_tokens, unit_read_usd, unit_rest_usd);

ALTER TABLE sessions ADD COLUMN changed_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_changed ON sessions (changed_seq);
CREATE TABLE change_cursor (seq INTEGER NOT NULL) STRICT;
INSERT INTO change_cursor (seq) VALUES (0);
`,
	`
ALTER TABLE calls ADD COLUMN response TEXT;
`,
	`
ALTER TABLE log_blocks ADD COLUMN parts TEXT;
`
];
const SCHEMA_VERSION = MIGRATIONS.length;
/** Bring the database to SCHEMA_VERSION, one transaction per migration. Returns the version. */
function migrate(db) {
	db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
	const current = Number(db.prepare("SELECT version FROM schema_version").get()?.version ?? 0);
	if (current > SCHEMA_VERSION) throw new Error(`the database's schema version ${current} is newer than this engine's (${SCHEMA_VERSION})`);
	for (let version = current; version < SCHEMA_VERSION; version++) db.transaction(() => {
		db.exec(MIGRATIONS[version] ?? "");
		db.exec("DELETE FROM schema_version");
		db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version + 1);
	});
	return SCHEMA_VERSION;
}
// packages/engine/src/store/own.ts
/** Tell a Quantext store from another program's SQLite file before anything writes to it. */
/** `quantext.db` is not a store this engine made: it is left as it is, and the user is told to move it aside. */
var ForeignDatabaseError = class extends Error {
	path;
	constructor(path, reason) {
		super(`${path} is not a Quantext database (${reason}). Quantext does not change it: move it aside (for example \`mv "${path}" "${path}.old"\`) and start again`);
		this.name = "ForeignDatabaseError";
		this.path = path;
	}
};
/** Tables that every schema version of the store has, with a column each, as a marker beside `schema_version`. */
const MARKERS = [
	["logs", "adapter_version"],
	["ingest_files", "byte_offset"],
	["calls", "framing_tokens"],
	["call_blocks", "first_call"]
];
/**
* Throw ForeignDatabaseError when the file at `path` holds tables but is no Quantext store: no `schema_version`
* with one positive version, or a missing marker table; throw when its version is newer than this engine's.
* Reads it read-only; a missing or empty file passes (a new store).
*/
async function refuseForeign(path) {
	if ((statOrUndefined(path)?.size ?? 0) === 0) return;
	const bun = process.versions.bun !== void 0;
	const db = await openRaw(bun ? path : `${pathToFileURL(path).href}?immutable=1`, { readOnly: !bun }).catch((error) => {
		throw new ForeignDatabaseError(path, `it cannot be read as SQLite: ${String(error)}`);
	});
	try {
		const reason = foreignReason(db);
		if (reason !== void 0) throw new ForeignDatabaseError(path, reason);
	} catch (error) {
		if (error instanceof ForeignDatabaseError || error instanceof NewerStoreError) throw error;
		throw new ForeignDatabaseError(path, `it cannot be read as SQLite: ${String(error)}`);
	} finally {
		db.close();
	}
}
function foreignReason(db) {
	const prepare = (sql) => db.prepare(sql);
	const tables = new Set(prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name)));
	if (tables.size === 0) return void 0;
	if (!tables.has("schema_version")) return "it has tables but no schema version";
	const versions = prepare("SELECT version FROM schema_version").all();
	const version = versions[0]?.version;
	const known = typeof version === "number" || typeof version === "bigint";
	if (versions.length !== 1 || !known || !Number.isInteger(Number(version)) || Number(version) < 1) return "its schema version is not one Quantext writes";
	if (Number(version) > SCHEMA_VERSION) throw new NewerStoreError(Number(version));
	for (const [table, column] of MARKERS) {
		const has = tables.has(table) && prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
		if (has === false || has === void 0) return `it has no ${table}.${column}`;
	}
}
/** The store is of a newer engine: this one must not read or change it. */
var NewerStoreError = class extends Error {
	constructor(version) {
		super(`the database's schema version ${version} is newer than this engine's (${SCHEMA_VERSION})`);
	}
};
function statOrUndefined(path) {
	try {
		return statSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
}
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
function sessionRow(s) {
	return [
		s.id,
		s.parentId,
		s.harness,
		s.harnessVersion,
		s.project,
		s.cwd,
		s.started,
		s.ended,
		s.requestLog,
		s.title,
		s.titleSource,
		s.agentName
	].map(nul);
}
function session$1(r) {
	const s = {
		id: text(r.id),
		harness: text(r.harness),
		requestLog: text(r.request_log)
	};
	put(s, "parentId", r.parent_id);
	put(s, "harnessVersion", r.harness_version);
	put(s, "project", r.project);
	put(s, "cwd", r.cwd);
	put(s, "started", r.started);
	put(s, "ended", r.ended);
	put(s, "title", r.title);
	if (r.title_source !== null) s.titleSource = text(r.title_source);
	put(s, "agentName", r.agent_name);
	return s;
}
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
function callRow(c) {
	const u = c.usage;
	const cost = c.cost;
	return [
		c.id,
		c.sessionId,
		c.index,
		c.lane,
		c.ts,
		c.model,
		c.canonicalModel,
		JSON.stringify(c.params),
		c.shapeHash,
		u?.basis,
		u?.inputTokens,
		u?.cacheReadTokens,
		u?.cacheWriteTokens,
		u?.cacheWrite5mTokens,
		u?.cacheWrite1hTokens,
		u?.outputTokens,
		u?.reasoningOutputTokens,
		c.speed,
		c.serviceTier,
		c.inferenceGeo,
		cost?.inputUsd,
		cost?.cacheReadUsd,
		cost?.cacheWriteUsd,
		cost?.outputUsd,
		cost?.totalUsd,
		cost?.price.model,
		cost?.price.source,
		cost?.price.date,
		cost === void 0 ? void 0 : JSON.stringify(cost.price.modifiers),
		c.blockCount,
		JSON.stringify(c.cacheBreakpoints),
		c.cacheBoundary?.tokens,
		c.cacheBoundary?.position,
		c.framingTokens,
		JSON.stringify(c.issues),
		c.turnDurationMs,
		c.response === void 0 ? void 0 : JSON.stringify(c.response)
	].map(nul);
}
function call$1(r) {
	const c = {
		id: text(r.id),
		sessionId: text(r.session_id),
		index: Number(r.idx),
		ts: text(r.ts),
		model: text(r.model),
		params: json$2(r.params),
		lane: text(r.lane),
		cacheBreakpoints: json$2(r.cache_breakpoints),
		framingTokens: Number(r.framing_tokens),
		issues: json$2(r.issues)
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
			modifiers: json$2(r.price_modifiers)
		}
	};
	putNumber(c, "blockCount", r.block_count);
	if (r.cache_boundary_tokens !== null) c.cacheBoundary = {
		tokens: Number(r.cache_boundary_tokens),
		position: Number(r.cache_boundary_position)
	};
	putNumber(c, "turnDurationMs", r.turn_duration_ms);
	if (r.response !== null && r.response !== void 0) c.response = json$2(r.response);
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
/** A Block's classification in one log: its kind, source and parts. Its content is stored once, by hash. */
function logBlockRow(b) {
	return [
		b.hash,
		b.kind,
		...sourceRow(b.source),
		b.parts === void 0 ? void 0 : JSON.stringify(b.parts)
	].map(nul);
}
/** A Block from its log row and its content; the display text is derived from the content. */
function block(r, content, display) {
	const b = {
		hash: text(r.hash),
		kind: text(r.kind),
		source: source(r),
		text: display,
		content
	};
	if (r.parts !== null && r.parts !== void 0) b.parts = json$2(r.parts);
	return b;
}
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
function runRow(r) {
	return [
		r.id,
		r.sessionId,
		r.lane,
		r.blockHash,
		r.position,
		r.section,
		r.message,
		r.tokens,
		r.basis,
		r.group,
		r.firstCall,
		r.lastCall
	].map(nul);
}
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
/** A ToolCall's row; `byBlock`: its input is the input of its tool use Block, so it is not stored again. */
function toolCallRow(t, byBlock) {
	return [
		t.id,
		t.sessionId,
		t.callId,
		t.name,
		byBlock ? void 0 : JSON.stringify(t.input),
		t.blockHash,
		...sourceRow(t.source),
		t.resultBlockHash,
		t.isError ? 1 : 0,
		t.durationMs,
		t.parallel,
		t.childSessionId
	].map(nul);
}
/** A ToolCall from its row; `content` gives a Block's content, for an input stored by its Block. */
function toolCall(r, content) {
	const fromBlock = r.input === null ? content(text(r.block_hash)) : void 0;
	const t = {
		id: text(r.id),
		sessionId: text(r.session_id),
		callId: text(r.call_id),
		name: text(r.name),
		input: r.input === null ? fromBlock?.input ?? null : json$2(r.input),
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
function compactionRow(c) {
	return [
		c.id,
		c.sessionId,
		c.ts,
		c.trigger,
		c.beforeTokens,
		c.afterTokens,
		c.beforeCallId,
		c.summaryCallId
	].map(nul);
}
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
function eventRow(e) {
	return [
		e.id,
		e.sessionId,
		e.ts,
		e.kind,
		e.value,
		e.detail === void 0 ? void 0 : JSON.stringify(e.detail)
	].map(nul);
}
function event(r) {
	const e = {
		id: text(r.id),
		sessionId: text(r.session_id),
		kind: text(r.kind),
		value: text(r.value)
	};
	put(e, "ts", r.ts);
	if (r.detail !== null) e.detail = json$2(r.detail);
	return e;
}
function sourceRow(s) {
	return [
		s.tool,
		s.filePath,
		s.mcpServer,
		s.skill,
		s.attachment
	];
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
function json$2(value) {
	return JSON.parse(text(value));
}
function text(value) {
	return typeof value === "string" ? value : String(value);
}
function nul(value) {
	return value ?? null;
}
/** Set an optional text field from a column, leaving it out when the column is NULL. */
function put(target, key, value) {
	if (value !== null && value !== void 0) target[key] = text(value);
}
function putNumber(target, key, value) {
	if (value !== null && value !== void 0) target[key] = Number(value);
}
// packages/engine/src/store/statements.ts
var Statements = class {
	db;
	cache = /* @__PURE__ */ new Map();
	constructor(db) {
		this.db = db;
	}
	get(sql) {
		let statement = this.cache.get(sql);
		if (statement === void 0) {
			statement = this.db.prepare(sql);
			this.cache.set(sql, statement);
		}
		return statement;
	}
};
/** An insert of one row of a log's table that replaces the columns of the row with the same (log, key). */
function upsertSql(table, columns, key = ["id"]) {
	const updates = columns.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
	return `INSERT INTO ${table} (log, ${columns.join(", ")}) VALUES (?${", ?".repeat(columns.length)})
    ON CONFLICT (log, ${key.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}
// packages/engine/src/store/log.ts
const UPSERT_SESSION = upsertSql("sessions", SESSION_COLUMNS);
const UPSERT_CALL = upsertSql("calls", CALL_COLUMNS);
/** A run is one Block at one position from its first Call on: that is its key (its id is made of the same parts). */
const UPSERT_RUN = upsertSql("call_blocks", RUN_COLUMNS, [
	"session_id",
	"lane",
	"first_call",
	"position"
]);
const UPSERT_TOOL_CALL = upsertSql("tool_calls", TOOL_CALL_COLUMNS);
const UPSERT_COMPACTION = upsertSql("compactions", COMPACTION_COLUMNS);
const UPSERT_EVENT = upsertSql("session_events", EVENT_COLUMNS);
const UPSERT_MESSAGE = upsertSql("messages", [
	"key",
	"role",
	"blocks"
], ["key"]);
const UPSERT_SHAPE = upsertSql("shapes", [
	"key",
	"tools",
	"system"
], ["key"]);
const UPSERT_RECORD = upsertSql("records", ["key", "value"], ["key"]);
const UPSERT_LOG_BLOCK = upsertSql("log_blocks", LOG_BLOCK_COLUMNS, ["hash"]);
/**
* What the store derives for a Call when it writes it: its tokens before the cache boundary (the Blocks wholly inside
* the Cached prefix; NULL when not split), its price per cache-read token, and per other input token (cache write,
* or plain input when it wrote none). The lifetime cost reads them from the lane index.
*/
const SET_DERIVED = `UPDATE calls SET cache_boundary_offset = CASE WHEN cache_boundary_position IS NULL THEN NULL
  ELSE (SELECT coalesce(sum(r.tokens), 0) FROM call_blocks r
    WHERE r.log = calls.log AND r.session_id = calls.session_id AND r.lane = calls.lane AND r.first_call <= calls.idx
      AND (r.last_call IS NULL OR r.last_call >= calls.idx) AND r.position < calls.cache_boundary_position) END,
  unit_read_usd = CASE WHEN cache_read_tokens > 0 THEN cost_cache_read_usd / cache_read_tokens END,
  unit_rest_usd = CASE WHEN cache_write_tokens > 0 THEN cost_cache_write_usd / cache_write_tokens
    WHEN input_tokens > 0 THEN cost_input_usd / input_tokens END
  WHERE log = ? AND id = ?`;
const UPSERT_FILE = `INSERT INTO ingest_files
  (path, log, transcript, kind, file_id, size, mtime_ms, byte_offset, fingerprint, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (path) DO UPDATE SET log = excluded.log, transcript = excluded.transcript, kind = excluded.kind,
    file_id = excluded.file_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
    byte_offset = excluded.byte_offset, fingerprint = excluded.fingerprint, error = excluded.error`;
function openLog(db, sql, path, harness, codec) {
	sql.get("INSERT INTO logs (path, harness, adapter_version) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING").run(path, harness, codec.version);
	const row = sql.get("SELECT id, harness, adapter_version FROM logs WHERE path = ?").get(path);
	if (row === void 0) throw new Error(`log ${path} was not created`);
	if (row.harness !== harness) throw new Error(`log ${path} is a ${String(row.harness)} log, not ${harness}`);
	const id = Number(row.id);
	const reset = () => db.transaction(() => {
		sql.get("DELETE FROM logs WHERE id = ?").run(id);
		sql.get("INSERT INTO logs (id, path, harness, adapter_version) VALUES (?, ?, ?, ?)").run(id, path, harness, codec.version);
		sql.get("UPDATE change_cursor SET seq = seq + 1").run();
		return Number(sql.get("SELECT seq FROM change_cursor").get()?.seq);
	});
	let emptied;
	if (Number(row.adapter_version) !== codec.version) emptied = { cursor: reset() };
	const one = (query, ...params) => sql.get(query).get(id, ...params);
	const all = (query, ...params) => sql.get(query).all(id, ...params);
	const media = (hash) => {
		const r = sql.get("SELECT bytes FROM media WHERE hash = ?").get(hash);
		if (!(r?.bytes instanceof Uint8Array)) throw new Error(`the store has no media ${hash}`);
		return r.bytes;
	};
	const content = (hash) => {
		const r = sql.get("SELECT content FROM blocks WHERE hash = ?").get(hash);
		if (r === void 0) throw new Error(`the store has no content for block ${hash}`);
		return codec.unpackContent(json$2(r.content), media);
	};
	const blockOf = (r) => {
		const c = content(String(r.hash));
		return block(r, c, codec.text(c));
	};
	const parts = (hashes) => json$2(hashes).map((hash) => ({
		hash,
		content: content(hash)
	}));
	const lookup = {
		record(key) {
			const m = one("SELECT role, blocks FROM messages WHERE log = ? AND key = ?", key);
			if (m !== void 0) return codec.unpack({
				kind: "message",
				key,
				role: String(m.role),
				parts: parts(m.blocks)
			});
			const s = one("SELECT tools, system FROM shapes WHERE log = ? AND key = ?", key);
			if (s !== void 0) return codec.unpack({
				kind: "shape",
				key,
				tools: parts(s.tools),
				system: parts(s.system)
			});
			const r = one("SELECT value FROM records WHERE log = ? AND key = ?", key);
			return r === void 0 ? void 0 : codec.unpack({
				kind: "value",
				key,
				value: json$2(r.value)
			});
		},
		block(hash) {
			const r = one("SELECT * FROM log_blocks WHERE log = ? AND hash = ?", hash);
			return r === void 0 ? void 0 : blockOf(r);
		},
		call(callId) {
			const r = one("SELECT * FROM calls WHERE log = ? AND id = ?", callId);
			return r === void 0 ? void 0 : call$1(r);
		},
		toolCall(toolCallId) {
			const r = one("SELECT * FROM tool_calls WHERE log = ? AND id = ?", toolCallId);
			return r === void 0 ? void 0 : toolCall(r, content);
		},
		openRuns(sessionId, lane) {
			return all("SELECT * FROM call_blocks WHERE log = ? AND session_id = ? AND lane = ? AND last_call IS NULL", sessionId, lane).map(run);
		}
	};
	/** Insert content once (its media apart): a hash already stored is not serialised again. */
	const putContent = (hash, value) => {
		if (sql.get("SELECT 1 FROM blocks WHERE hash = ?").get(hash) !== void 0) return;
		const packed = codec.packContent(value);
		for (const m of packed.media) sql.get("INSERT INTO media (hash, media_type, bytes) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(m.hash, m.mediaType, m.bytes);
		sql.get("INSERT INTO blocks (hash, content) VALUES (?, ?)").run(hash, JSON.stringify(packed.content));
	};
	const ensureContent = (list) => {
		for (const part of list) putContent(part.hash, part.content);
		return JSON.stringify(list.map((p) => p.hash));
	};
	const apply = (delta, result, touched, calls) => {
		for (const s of delta.sessions) touched.add(s.id);
		for (const c of delta.calls) {
			touched.add(c.sessionId);
			calls.add(c.id);
		}
		for (const x of [
			...delta.callBlocks,
			...delta.toolCalls,
			...delta.compactions,
			...delta.events
		]) touched.add(x.sessionId);
		for (const record of delta.records) {
			const stored = codec.pack(record);
			if (stored.kind === "message") sql.get(UPSERT_MESSAGE).run(id, stored.key, stored.role, ensureContent(stored.parts));
			else if (stored.kind === "shape") sql.get(UPSERT_SHAPE).run(id, stored.key, ensureContent(stored.tools), ensureContent(stored.system));
			else sql.get(UPSERT_RECORD).run(id, stored.key, JSON.stringify(stored.value));
		}
		for (const b of delta.blocks) {
			putContent(b.hash, b.content);
			sql.get(UPSERT_LOG_BLOCK).run(id, ...logBlockRow(b));
		}
		for (const s of delta.sessions) sql.get(UPSERT_SESSION).run(id, ...sessionRow(s));
		for (const c of delta.calls) {
			const isNew = one("SELECT 1 FROM calls WHERE log = ? AND id = ?", c.id) === void 0;
			sql.get(UPSERT_CALL).run(id, ...callRow(c));
			const entry = result.get(c.sessionId) ?? {
				added: [],
				addedIndexes: [],
				updated: []
			};
			result.set(c.sessionId, entry);
			if (isNew) {
				entry.added.push(c.id);
				entry.addedIndexes.push(c.index);
			} else if (!entry.added.includes(c.id) && !entry.updated.includes(c.id)) entry.updated.push(c.id);
		}
		for (const r of delta.callBlocks) sql.get(UPSERT_RUN).run(id, ...runRow(r));
		for (const t of delta.toolCalls) {
			const byBlock = t.blockHash !== void 0 && sql.get("SELECT 1 FROM blocks WHERE hash = ?").get(t.blockHash) !== void 0;
			sql.get(UPSERT_TOOL_CALL).run(id, ...toolCallRow(t, byBlock));
		}
		for (const c of delta.compactions) sql.get(UPSERT_COMPACTION).run(id, ...compactionRow(c));
		for (const e of delta.events) sql.get(UPSERT_EVENT).run(id, ...eventRow(e));
		const counts = [["unknown", delta.report.unknownRecords], ["ignored", delta.report.ignoredRecords]];
		for (const [status, list] of counts) for (const { kind, count } of list) sql.get(`INSERT INTO report_kinds (log, status, kind, count, seq)
             VALUES (?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM report_kinds WHERE log = ?))
             ON CONFLICT (log, status, kind) DO UPDATE SET count = count + excluded.count`).run(id, status, kind, count, id);
		for (const { at, reason } of delta.report.unreadable) sql.get(`INSERT INTO report_unreadable (log, seq, at, reason)
           VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM report_unreadable WHERE log = ?), ?, ?)`).run(id, id, at, reason);
	};
	return {
		path,
		id,
		...emptied === void 0 ? {} : { emptied },
		lookup,
		snapshot() {
			const r = sql.get("SELECT snapshot FROM logs WHERE id = ?").get(id);
			return r?.snapshot === null || r === void 0 ? void 0 : json$2(r.snapshot);
		},
		files: () => all("SELECT * FROM ingest_files WHERE log = ? ORDER BY path").map(fileMark),
		write(batch) {
			return db.transaction(() => {
				const result = /* @__PURE__ */ new Map();
				const touched = /* @__PURE__ */ new Set();
				const calls = /* @__PURE__ */ new Set();
				for (const delta of batch.deltas) apply(delta, result, touched, calls);
				for (const callId of calls) sql.get(SET_DERIVED).run(id, callId);
				let cursor = Number(sql.get("SELECT seq FROM change_cursor").get()?.seq ?? 0);
				if (touched.size > 0) {
					cursor++;
					sql.get("UPDATE change_cursor SET seq = ?").run(cursor);
					for (const sessionId of touched) sql.get("UPDATE sessions SET changed_seq = ? WHERE log = ? AND id = ?").run(cursor, id, sessionId);
				}
				if (batch.snapshot !== void 0) sql.get("UPDATE logs SET snapshot = ? WHERE id = ?").run(JSON.stringify(batch.snapshot), id);
				for (const f of batch.files ?? []) sql.get(UPSERT_FILE).run(f.path, id, f.transcript, f.kind, f.fileId ?? null, f.size, f.mtimeMs ?? null, f.offset, f.fingerprint ?? null, f.error ?? null);
				return {
					log: id,
					cursor,
					calls: [...result].map(([sessionId, c]) => ({
						sessionId,
						...c
					})),
					sessions: [...touched]
				};
			});
		},
		reset,
		graph() {
			const rows = (table) => all(`SELECT * FROM ${table} WHERE log = ? ORDER BY id`);
			const kinds = (status) => all("SELECT kind, count FROM report_kinds WHERE log = ? AND status = ? ORDER BY seq", status).map((r) => ({
				kind: String(r.kind),
				count: Number(r.count)
			}));
			const blocks = all("SELECT * FROM log_blocks WHERE log = ? ORDER BY hash");
			return {
				sessions: rows("sessions").map(session$1),
				calls: rows("calls").map(call$1),
				blocks: blocks.map(blockOf),
				callBlocks: rows("call_blocks").map(run),
				toolCalls: rows("tool_calls").map((r) => toolCall(r, content)),
				compactions: rows("compactions").map(compaction),
				events: rows("session_events").map(event),
				report: {
					unknownRecords: kinds("unknown"),
					ignoredRecords: kinds("ignored"),
					unreadable: all("SELECT at, reason FROM report_unreadable WHERE log = ? ORDER BY seq").map((r) => ({
						at: String(r.at),
						reason: String(r.reason)
					}))
				}
			};
		}
	};
}
function fileMark(r) {
	const mark = {
		path: String(r.path),
		transcript: String(r.transcript),
		kind: r.kind === "meta" ? "meta" : "transcript",
		size: Number(r.size),
		offset: Number(r.byte_offset)
	};
	if (r.file_id !== null) mark.fileId = String(r.file_id);
	if (r.mtime_ms !== null) mark.mtimeMs = Number(r.mtime_ms);
	if (r.fingerprint !== null) mark.fingerprint = String(r.fingerprint);
	if (r.error !== null) mark.error = String(r.error);
	return mark;
}
// packages/engine/src/store/store.ts
/** The store: one SQLite database in the data folder, written by one engine at a time. */
/** The default data folder, `~/.quantext`: outside the plugin folder, which an uninstall deletes. */
function defaultDataDir(home) {
	return join(home, ".quantext");
}
/** Open the store for writing: take the writer lock, open the database, migrate it to the current schema. */
async function openStore(options) {
	mkdirSync(options.dataDir, {
		recursive: true,
		mode: 448
	});
	const lock = await acquireLock(join(options.dataDir, "writer.lock"), join(options.dataDir, "writer.pid"));
	const path = join(options.dataDir, "quantext.db");
	let db;
	try {
		await refuseForeign(path);
		privateFile(path);
		db = await openDriver(path);
		const schemaVersion = migrate(db);
		const opened = db;
		const sql = new Statements(opened);
		const kinds = (status) => sql.get(`SELECT kind, sum(count) AS count FROM report_kinds WHERE status = ?
           GROUP BY kind ORDER BY count DESC, kind`).all(status).map((r) => ({
			kind: String(r.kind),
			count: Number(r.count)
		}));
		return {
			path,
			schemaVersion,
			db: opened,
			log: (logPath, harness, codec) => openLog(opened, sql, logPath, harness, codec),
			report: () => ({
				unknownRecords: kinds("unknown"),
				ignoredRecords: kinds("ignored"),
				unreadable: sql.get(`SELECT l.path, r.at, r.reason FROM report_unreadable r JOIN logs l ON l.id = r.log
             ORDER BY r.log, r.seq`).all().map((r) => ({
					log: String(r.path),
					at: String(r.at),
					reason: String(r.reason)
				})),
				errors: sql.get("SELECT path, error FROM ingest_files WHERE error IS NOT NULL ORDER BY path").all().map((r) => ({
					path: String(r.path),
					error: String(r.error)
				})),
				files: sql.get(`SELECT path, size - byte_offset AS pending FROM ingest_files
             WHERE kind = 'transcript' AND error IS NULL AND size > byte_offset ORDER BY path`).all().map((r) => ({
					path: String(r.path),
					pendingBytes: Number(r.pending)
				})),
				scan: sql.get("SELECT path, issue FROM scan_issues ORDER BY path").all().map((r) => ({
					path: String(r.path),
					issue: String(r.issue)
				})),
				requestLogs: sql.get("SELECT request_log, count(*) AS n FROM sessions GROUP BY request_log ORDER BY request_log").all().map((r) => ({
					requestLog: String(r.request_log),
					sessions: Number(r.n)
				}))
			}),
			setScanIssues(issues) {
				opened.transaction(() => {
					sql.get("DELETE FROM scan_issues").run();
					for (const { path: at, issue } of issues) sql.get("INSERT INTO scan_issues (path, issue) VALUES (?, ?) ON CONFLICT DO NOTHING").run(at, issue);
				});
			},
			memory: {
				marks: () => sql.get("SELECT project_dir, path, mtime_ms, size FROM project_memory ORDER BY project_dir, path").all().map((r) => ({
					projectDir: String(r.project_dir),
					path: String(r.path),
					mtimeMs: Number(r.mtime_ms),
					size: Number(r.size)
				})),
				write: ({ put, remove }) => opened.transaction(() => {
					for (const d of put) sql.get(`INSERT INTO project_memory (project_dir, path, content, mtime_ms, size) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (project_dir, path) DO UPDATE SET content = excluded.content,
                     mtime_ms = excluded.mtime_ms, size = excluded.size`).run(d.projectDir, d.path, d.content, d.mtimeMs, d.size);
					for (const d of remove) sql.get("DELETE FROM project_memory WHERE project_dir = ? AND path = ?").run(d.projectDir, d.path);
					sql.get("UPDATE change_cursor SET seq = seq + 1").run();
					return Number(sql.get("SELECT seq FROM change_cursor").get()?.seq);
				})
			},
			changeCursor: () => Number(sql.get("SELECT seq FROM change_cursor").get()?.seq ?? 0),
			fileOffsets: () => new Map(sql.get("SELECT path, byte_offset FROM ingest_files").all().map((r) => [String(r.path), Number(r.byte_offset)])),
			logs: () => sql.get("SELECT path FROM logs ORDER BY id").all().map((r) => String(r.path)),
			close() {
				opened.close();
				lock.release();
			}
		};
	} catch (error) {
		db?.close();
		lock.release();
		throw error;
	}
}
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
// packages/engine/src/query/sql.ts
/** The statement is not a single read: nothing was run. */
var SqlRejectedError = class extends Error {
	name = "SqlRejectedError";
};
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
		const content = json$2(raw);
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
			const content = json$2(r.content);
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
			const content = (hash) => json$2(q("SELECT content FROM blocks WHERE hash = ?").get(hash)?.content);
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
// packages/engine/src/cli/format.ts
/** Rows as an aligned table with a header line; cells are cut to their column's `max` */
function table(rows, columns) {
	const cells = rows.map((row) => columns.map((c) => cut(oneLine(c.value(row)), c.max)));
	const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => (r[i] ?? "").length)));
	const line = (values) => values.map((v, i) => columns[i]?.right === true ? v.padStart(widths[i] ?? 0) : v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
	return [line(columns.map((c) => c.title)), ...cells.map(line)].join("\n");
}
/** `12,345` */
function count(n) {
	return n === void 0 ? "-" : Math.round(n).toLocaleString("en-US");
}
/** `$0.1234` (four decimals below a dollar, else two). */
function usd(n) {
	if (n === void 0) return "-";
	return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}
/** `87%` */
function percent(rate) {
	return rate === void 0 ? "-" : `${Math.round(rate * 100)}%`;
}
/** `2026-11-12 00:26` from an ISO time, in UTC. */
function time(iso) {
	return iso === void 0 ? "-" : iso.replace("T", " ").slice(0, 16);
}
/** `1.2 MB` */
function bytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function oneLine(text) {
	return text.replace(/\s+/g, " ").trim();
}
function cut(text, max) {
	return max === void 0 || text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
// packages/engine/src/cli/print.ts
function printSessions(page) {
	const rows = page.items.flatMap((s) => [{
		s,
		depth: 0
	}, ...(s.subagents ?? []).map((a) => ({
		s: a,
		depth: 1
	}))]);
	const columns = [
		{
			title: "SESSION",
			value: ({ s, depth }) => depth > 0 ? `└ ${s.agentName ?? s.id.slice(s.id.lastIndexOf(":") + 1)}` : s.id
		},
		{
			title: "ENDED",
			value: ({ s }) => time(s.ended)
		},
		{
			title: "CALLS",
			value: ({ s }) => String(s.calls),
			right: true
		},
		{
			title: "COST",
			value: ({ s }) => usd(s.cost.totalUsd),
			right: true
		},
		{
			title: "MAX CTX",
			value: ({ s }) => count(s.maxContextTokens),
			right: true
		},
		{
			title: "CACHE",
			value: ({ s }) => percent(s.cacheHitRate),
			right: true
		},
		{
			title: "FLAGS",
			value: ({ s }) => flags(s)
		},
		{
			title: "TITLE / PROJECT",
			value: ({ s }) => s.title ?? s.agentName ?? s.project ?? "",
			max: 60
		}
	];
	const shown = `${page.items.length === 0 ? 0 : page.offset + 1}-${page.offset + page.items.length} of ${page.total}`;
	return `${table(rows, columns)}\n\n${shown} sessions\n`;
}
function flags(s) {
	const out = [];
	if (s.live) out.push("live");
	if (s.requestLog !== "present") out.push(`requests:${s.requestLog}`);
	const issues = Object.values(s.issues).reduce((n, k) => n + (k ?? 0), 0);
	if (issues > 0) out.push(`issues:${issues}`);
	if (s.unpricedCalls > 0) out.push(`unpriced:${s.unpricedCalls}`);
	return out.join(" ");
}
function printSession(d) {
	const s = d.session;
	const lines = [
		`${s.title ?? s.id}`,
		`  id ${s.id} (log ${s.log})${s.parentId === void 0 ? "" : `, subagent of ${s.parentId}`}`,
		`  project ${s.project ?? "-"}, cwd ${s.cwd ?? "-"}`,
		`  ${time(s.started)} to ${time(s.ended)}${s.live ? " (live)" : ""}, ${s.harness} ${s.harnessVersion ?? ""}`.trimEnd(),
		`  models ${s.models.join(", ") || "-"}; requests ${s.requestLog}`,
		`  ${s.calls} calls, ${usd(s.cost.totalUsd)}: input ${usd(s.cost.inputUsd)}, cache read ${usd(s.cost.cacheReadUsd)}, cache write ${usd(s.cost.cacheWriteUsd)}, output ${usd(s.cost.outputUsd)}`,
		`  tokens: input ${count(s.tokens.input)}, cache read ${count(s.tokens.cacheRead)}, cache write ${count(s.tokens.cacheWrite)}, output ${count(s.tokens.output)}; max context ${count(s.maxContextTokens)}; cache hit ${percent(s.cacheHitRate)}`
	];
	const issues = Object.entries(s.issues).map(([k, n]) => `${k} ${n}`);
	if (issues.length > 0) lines.push(`  issues: ${issues.join(", ")}`);
	lines.push("", table(d.lanes, [
		{
			title: "LANE",
			value: (l) => l.lane
		},
		{
			title: "CALLS",
			value: (l) => String(l.calls),
			right: true
		},
		{
			title: "FIRST",
			value: (l) => String(l.firstCall),
			right: true
		},
		{
			title: "LAST",
			value: (l) => String(l.lastCall),
			right: true
		}
	]));
	if (d.compactions.length > 0) lines.push("", table(d.compactions, [
		{
			title: "COMPACTION",
			value: (c) => time(c.ts)
		},
		{
			title: "TRIGGER",
			value: (c) => c.trigger
		},
		{
			title: "BEFORE",
			value: (c) => count(c.beforeTokens),
			right: true
		},
		{
			title: "AFTER",
			value: (c) => count(c.afterTokens),
			right: true
		},
		{
			title: "REMOVED",
			value: (c) => count(c.removed?.tokens),
			right: true
		},
		{
			title: "KEPT",
			value: (c) => count(c.kept?.tokens),
			right: true
		},
		{
			title: "SUMMARY",
			value: (c) => count(c.summaryTokens),
			right: true
		},
		{
			title: "CALLS",
			value: (c) => `${c.beforeCallIndex ?? "-"} → ${c.afterCallIndex ?? "-"}`
		}
	]));
	if (d.events.length > 0) lines.push("", table(d.events, [
		{
			title: "EVENT",
			value: (e) => time(e.ts)
		},
		{
			title: "KIND",
			value: (e) => e.kind
		},
		{
			title: "VALUE",
			value: (e) => e.value,
			max: 80
		}
	]));
	if (d.subagents.length > 0) lines.push("", table(d.subagents, [
		{
			title: "SUBAGENT",
			value: (a) => a.id
		},
		{
			title: "AGENT",
			value: (a) => a.agentName ?? "-"
		},
		{
			title: "CALLS",
			value: (a) => String(a.calls),
			right: true
		},
		{
			title: "COST",
			value: (a) => usd(a.cost.totalUsd),
			right: true
		}
	]));
	return `${lines.join("\n")}\n`;
}
function printCall(ctx, diff) {
	const c = ctx.call;
	const u = c.usage;
	const head = [`call ${c.index} of ${ctx.session.id} (lane ${c.lane}), ${time(c.ts)}, ${c.model}`, u === void 0 ? "  no usage" : `  input ${count(ctx.totalTokens)}: cache read ${count(u.cacheReadTokens)}, cache write ${count(u.cacheWriteTokens)}, uncached ${count(u.inputTokens)}; output ${count(u.outputTokens)}; cost ${usd(c.cost?.totalUsd)}`];
	if (c.issues.length > 0) head.push(`  issues: ${c.issues.map((i) => `${i.kind} (${i.detail})`).join("; ")}`);
	if (!ctx.rebuilt) return `${head.join("\n")}\n  the log holds no request for this call: its context cannot be shown\n`;
	const body = table(ctx.blocks, [
		{
			title: "POS",
			value: (b) => String(b.position),
			right: true
		},
		{
			title: "SECTION",
			value: (b) => b.section
		},
		{
			title: "KIND",
			value: (b) => b.deferred === true ? `${b.kind} (deferred)` : b.kind
		},
		{
			title: "SOURCE",
			value: (b) => b.source.mcpServer ?? b.source.skill ?? b.source.filePath ?? b.source.tool ?? b.source.attachment ?? "",
			max: 40
		},
		{
			title: "TOKENS",
			value: (b) => count(b.tokens),
			right: true
		},
		{
			title: "BASIS",
			value: (b) => b.basis ?? ""
		},
		{
			title: "CACHED",
			value: (b) => b.inCachedPrefix ? "yes" : ""
		},
		{
			title: "COST",
			value: (b) => usd(b.costUsd),
			right: true
		},
		{
			title: "TEXT",
			value: (b) => b.preview,
			max: 60
		}
	]);
	const categories = CATEGORIES.filter((k) => ctx.categories[k] > 0).map((k) => `${k} ${count(ctx.categories[k])}`).join(", ");
	const sections = `tools ${count(ctx.sections.tools)}, system ${count(ctx.sections.system)}, messages ${count(ctx.sections.messages)}, framing ${count(ctx.sections.framing)}`;
	const out = [
		...head,
		"",
		body,
		"",
		`sections: ${sections}`,
		`categories: ${categories}`
	];
	if (diff !== void 0) out.push("", diff.previous === void 0 ? "first call of its lane: every block is new" : `against call ${diff.previous}${diff.modelSwitch === true ? " (another model)" : ""}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.moved.length} moved, first change at position ${diff.firstChange ?? "-"}; cache read lost ${count(diff.cacheReadDrop)}; ${diff.uncached.length} kept blocks written to the cache again`);
	return `${out.join("\n")}\n`;
}
function printSql(result) {
	const columns = result.columns.map((name) => ({
		title: name,
		value: (row) => {
			const v = row[name];
			return v === null || v === void 0 ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
		},
		right: result.rows.length > 0 && result.rows.every((r) => typeof r[name] === "number" || r[name] === null),
		max: 80
	}));
	const note = result.truncated ? `${result.rows.length} rows shown; more were left out (--limit)` : `${result.rows.length} rows`;
	return `${table(result.rows, columns)}\n\n${note}\n`;
}
function printReport(r) {
	const lines = [];
	const list = (title, items) => {
		lines.push(`${title}: ${items.length === 0 ? "none" : ""}`);
		for (const i of items) lines.push(`  ${i}`);
	};
	list("unknown records", r.unknownRecords.map((k) => `${k.kind} ${k.count}`));
	list("ignored records", r.ignoredRecords.map((k) => `${k.kind} ${k.count}`));
	list("unreadable", r.unreadable.map((u) => `${u.log} ${u.at}: ${u.reason}`));
	list("file errors", r.errors.map((e) => `${e.path}: ${e.error}`));
	list("scan", r.scan.map((s) => `${s.path}: ${s.issue}`));
	list("call issues", Object.entries(r.issues).map(([k, n]) => `${k} ${n}`));
	list("request logs", r.requestLogs.map((x) => `${x.requestLog} ${x.sessions} sessions`));
	lines.push(`pending: ${bytes(r.pendingBytes)} in ${r.pending.length} files`);
	return `${lines.join("\n")}\n`;
}
function printToolOutputs(items) {
	return `${table(items, [
		{
			title: "TOOL",
			value: (o) => o.tool
		},
		{
			title: "CALL",
			value: (o) => o.callIndex === void 0 ? "-" : String(o.callIndex),
			right: true
		},
		{
			title: "TOKENS",
			value: (o) => count(o.tokens),
			right: true
		},
		{
			title: "CALLS",
			value: (o) => String(o.calls),
			right: true
		},
		{
			title: "LIFETIME",
			value: (o) => count(o.lifetimeTokens),
			right: true
		},
		{
			title: "COST",
			value: (o) => usd(o.costUsd.total),
			right: true
		},
		{
			title: "INPUT",
			value: (o) => o.inputSummary ?? "",
			max: 60
		}
	])}\n`;
}
function printBlockLifetimes(items) {
	return `${table(items, [
		{
			title: "KIND",
			value: (b) => b.kind
		},
		{
			title: "SOURCE",
			value: (b) => b.source.mcpServer ?? b.source.skill ?? b.source.filePath ?? b.source.tool ?? "",
			max: 40
		},
		{
			title: "TOKENS",
			value: (b) => count(b.tokens),
			right: true
		},
		{
			title: "CALLS",
			value: (b) => String(b.calls),
			right: true
		},
		{
			title: "LIFETIME",
			value: (b) => count(b.lifetimeTokens),
			right: true
		},
		{
			title: "READ",
			value: (b) => count(b.tokensByPart.cacheRead),
			right: true
		},
		{
			title: "WRITE",
			value: (b) => count(b.tokensByPart.cacheWrite),
			right: true
		},
		{
			title: "COST",
			value: (b) => usd(b.costUsd.total),
			right: true
		},
		{
			title: "BLOCK",
			value: (b) => b.hash.slice(0, 12)
		}
	])}\n`;
}
// packages/engine/src/api/params.ts
/**
* Strict reading of a request's query string and path segments: every parameter is named, typed and bounded, an
* unknown or repeated one is refused. Errors name the parameter, never repeat its value.
*/
var HttpError = class extends Error {
	status;
	code;
	constructor(status, code, message) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
	}
};
const badRequest = (message) => new HttpError(400, "bad-request", message);
const notFound = (message = "not found") => new HttpError(404, "not-found", message);
/** Longest text parameter (a project path, a search). */
const MAX_TEXT = 1024;
/** The query string, with each name checked against `allowed` and given at most once. */
function queryParams(search, allowed) {
	const seen = /* @__PURE__ */ new Set();
	for (const name of search.keys()) {
		if (!allowed.includes(name)) throw badRequest(`unknown parameter ${safeName(name)}`);
		if (seen.has(name)) throw badRequest(`parameter ${name} is given more than once`);
		seen.add(name);
	}
	return new Params(search);
}
var Params = class {
	#search;
	constructor(search) {
		this.#search = search;
	}
	/** A whole number in [min, max]; undefined when absent. */
	int(name, min, max) {
		const text = this.#search.get(name);
		return text === null ? void 0 : integer$1(text, name, min, max);
	}
	/** One of `values`; undefined when absent. */
	oneOf(name, values) {
		const text = this.#search.get(name);
		if (text === null) return void 0;
		if (!values.includes(text)) throw badRequest(`${name} must be one of ${values.join(", ")}`);
		return text;
	}
	/** Text of 1 to `max` characters with no control characters; undefined when absent. */
	text(name, max = MAX_TEXT) {
		const text = this.#search.get(name);
		return text === null ? void 0 : checkText(text, name, max);
	}
};
/** A whole number written in decimal, in [min, max]. */
function integer$1(text, name, min, max) {
	if (!/^\d{1,15}$/.test(text)) throw badRequest(`${name} must be a whole number`);
	const n = Number(text);
	if (n < min || n > max) throw badRequest(`${name} must be from ${min} to ${max}`);
	return n;
}
function checkText(text, name, max) {
	if (text.length === 0 || text.length > max) throw badRequest(`${name} must have 1 to ${max} characters`);
	if (/[\u0000-\u001f\u007f]/.test(text)) throw badRequest(`${name} must not hold control characters`);
	return text;
}
/** A parameter name fit to show: only when it is a short plain word. */
function safeName(name) {
	return /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(name) ? name : "(not shown)";
}
// packages/engine/src/api/http.ts
const API_VERSION$3 = 1;
/** The viewer's pages: scripts, styles and data only from the engine; no inline script or style, no frames. */
const HTML_CSP = [
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
/** Everything else (JSON, media, scripts) is not a document: should a browser render it, it may do nothing. */
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
/** On every response. No Access-Control-* header, ever: other origins must not read anything. */
const COMMON = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin"
};
function securityHeaders(html) {
	return {
		...COMMON,
		"Content-Security-Policy": html ? HTML_CSP : DATA_CSP
	};
}
/**
* Refuse a request this server must not answer, or return undefined. `port` is the port it listens on. A browser
* page of another origin can send a GET with no Origin header (an image, a script), so `Sec-Fetch-Site` is checked
* too; only a top-level navigation to a page (not the API) may come from another site, as a link does.
*/
function refusal(req, port, api) {
	const host = (req.headers.host ?? "").toLowerCase();
	if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return new HttpError(403, "forbidden-host", "this server answers only to 127.0.0.1 and localhost on its port");
	if (req.method !== "GET" && req.method !== "HEAD") return new HttpError(405, "method-not-allowed", "only GET and HEAD");
	const origin = req.headers.origin;
	if (origin !== void 0 && origin !== `http://${host}`) return new HttpError(403, "forbidden-origin", "requests from other origins are refused");
	const site = req.headers["sec-fetch-site"];
	if (site !== void 0 && site !== "same-origin" && site !== "none") {
		const navigation = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
		if (api || !navigation) return new HttpError(403, "forbidden-site", "requests from other sites are refused");
	}
	if ((req.url ?? "").length > 4096) return new HttpError(414, "uri-too-long", "the URL is too long");
	const length = req.headers["content-length"];
	if (length !== void 0 && length !== "0" || req.headers["transfer-encoding"] !== void 0) return new HttpError(413, "content-too-large", "requests have no body");
}
/** A JSON response; on HEAD, only its headers. */
function sendJson(req, res, status, body, extra = {}) {
	const bytes = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, {
		...securityHeaders(false),
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(bytes.length),
		"Cache-Control": "no-store",
		...extra
	});
	res.end(req.method === "HEAD" ? void 0 : bytes);
}
function sendError(req, res, error) {
	const body = {
		apiVersion: API_VERSION$3,
		error: {
			status: error.status,
			code: error.code,
			message: error.message
		}
	};
	const extra = error.status === 405 ? { Allow: "GET, HEAD" } : {};
	if (error.status === 413) {
		extra.Connection = "close";
		res.on("finish", () => req.socket.destroy());
	}
	sendJson(req, res, error.status, body, extra);
}
/** Bytes with their type and caching; on HEAD, only the headers. */
function sendBytes(req, res, bytes, headers, html) {
	res.writeHead(200, {
		...securityHeaders(html),
		"Content-Length": String(bytes.byteLength),
		...headers
	});
	res.end(req.method === "HEAD" ? void 0 : bytes);
}
// packages/engine/src/api/events.ts
const API_VERSION$2 = 1;
const after = (a, b) => a.c > b.c || a.c === b.c && a.o > b.o;
/** `12` (all of cursor 12) or `12.3` (cursor 12 up to its ordinal 3), as the event ids are written. */
function parseCursor(text) {
	const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text);
	if (m === null) throw badRequest("cursor must be an event id (12 or 12.3)");
	return {
		c: Number(m[1]),
		o: m[2] === void 0 ? Number.POSITIVE_INFINITY : Number(m[2])
	};
}
function createEventStream(options) {
	const { query } = options;
	const heartbeatMs = options.heartbeatMs ?? 15e3;
	const replayEvents = options.replayEvents ?? 1024;
	const maxBuffered = options.maxBufferedBytes ?? 1048576;
	const maxClients = options.maxClients ?? 16;
	const onError = options.onError ?? ((error) => console.error("quantext: an event was not sent:", error));
	const drainTimeoutMs = options.drainTimeoutMs ?? 3e4;
	/** Each stream, and whether it is live (else its replay is still being written). */
	const clients = /* @__PURE__ */ new Map();
	const ring = [];
	/** Clients at or after this place can be replayed from the ring. */
	let floor = {
		c: query.changeCursor(),
		o: Number.POSITIVE_INFINITY
	};
	let latest = floor.c;
	const drop = (res) => {
		clients.delete(res);
		res.destroy();
	};
	/** A live write: a client with more unsent bytes than the limit does not read, and is dropped. */
	const write = (res, text) => {
		if (res.destroyed) return;
		res.write(text);
		if (res.writableLength > maxBuffered) drop(res);
	};
	/** Resolves when `res` drained (true), or closed or timed out (false). */
	const drained = (res) => new Promise((resolve) => {
		const done = (ok) => {
			clearTimeout(timer);
			res.off("drain", onDrain);
			res.off("close", onClose);
			resolve(ok);
		};
		const onDrain = () => done(true);
		const onClose = () => done(false);
		const timer = setTimeout(() => done(false), drainTimeoutMs);
		res.on("drain", onDrain);
		res.on("close", onClose);
	});
	/**
	* Write the ring after `from`, a part at a time, then `ready`, and make the client live. Events that come
	* meanwhile go to the ring and are written by this loop, so the order holds.
	*/
	const replay = async (res, from, head) => {
		let text = head;
		let at = from;
		let replayed = 0;
		for (;;) {
			if (at !== void 0 && after(floor, at)) {
				drop(res);
				return;
			}
			const next = at === void 0 ? [] : ring.filter((k) => after(k, at));
			if (next.length === 0) break;
			for (const k of next) {
				text += eventFrame(k);
				at = k;
				replayed++;
				if (text.length >= 16384 || k === next.at(-1)) {
					if (res.destroyed) return;
					const ok = res.write(text);
					text = "";
					if ((!ok || res.writableLength > maxBuffered / 2) && !await drained(res)) {
						if (!res.destroyed) drop(res);
						return;
					}
				}
			}
		}
		if (res.destroyed) return;
		const ready = {
			apiVersion: API_VERSION$2,
			cursor: latest,
			replayed
		};
		res.write(text + frame("ready", String(latest), ready));
		const state = clients.get(res);
		if (state !== void 0) state.live = true;
	};
	const frame = (name, id, data) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
	const eventFrame = (k) => frame(k.event.kind, `${k.c}.${k.o}`, k.event);
	const ingestEveryMs = options.ingestEveryMs ?? 1e3;
	let ingestSentAt = Number.NEGATIVE_INFINITY;
	let ingestWaiting;
	let ingestTimer;
	const sendIngest = (status) => {
		ingestSentAt = performance.now();
		const body = {
			apiVersion: API_VERSION$2,
			...status
		};
		const text = `event: ingest\ndata: ${JSON.stringify(body)}\n\n`;
		for (const [res, state] of clients) if (state.live) write(res, text);
	};
	const heartbeat = setInterval(() => {
		for (const [res, state] of clients) if (state.live) write(res, ": ping\n\n");
	}, heartbeatMs);
	heartbeat.unref();
	return {
		publish(event) {
			let shown;
			try {
				shown = query.publicEvent(event);
			} catch (error) {
				floor = {
					c: Math.max(floor.c, event.cursor),
					o: Number.POSITIVE_INFINITY
				};
				latest = Math.max(latest, event.cursor);
				for (const res of clients.keys()) res.end();
				clients.clear();
				onError(error);
				return;
			}
			latest = Math.max(latest, event.cursor);
			if (shown === null) return;
			const last = ring.at(-1);
			const kept = {
				c: event.cursor,
				o: last?.c === event.cursor ? last.o + 1 : 0,
				event: shown
			};
			ring.push(kept);
			if (ring.length > replayEvents) {
				const dropped = ring.shift();
				floor = {
					c: dropped.c,
					o: dropped.o
				};
			}
			const text = eventFrame(kept);
			for (const [res, state] of clients) if (state.live) write(res, text);
		},
		publishIngest(status) {
			const wait = ingestSentAt + ingestEveryMs - performance.now();
			if (wait <= 0 && ingestTimer === void 0) {
				sendIngest(status);
				return;
			}
			ingestWaiting = status;
			ingestTimer ??= setTimeout(() => {
				ingestTimer = void 0;
				const latest = ingestWaiting;
				ingestWaiting = void 0;
				if (latest !== void 0) sendIngest(latest);
			}, Math.max(0, wait));
			ingestTimer.unref();
		},
		connect(req, res, cursorText) {
			const from = cursorText === void 0 ? void 0 : parseCursor(cursorText);
			if (clients.size >= maxClients) {
				res.writeHead(503, {
					...securityHeaders(false),
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"Retry-After": "5"
				});
				res.end(JSON.stringify({
					apiVersion: API_VERSION$2,
					error: {
						status: 503,
						code: "too-many-streams",
						message: "too many event streams are open"
					}
				}));
				return;
			}
			res.writeHead(200, {
				...securityHeaders(false),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no"
			});
			latest = Math.max(latest, query.changeCursor());
			clients.set(res, { live: false });
			const gone = () => clients.delete(res);
			req.on("close", gone);
			res.on("close", gone);
			let head = "retry: 2000\n\n";
			let start = from;
			if (from !== void 0 && (from.c > latest || after(floor, from))) {
				const resync = {
					apiVersion: API_VERSION$2,
					cursor: latest,
					since: from.c > latest ? 0 : from.c
				};
				head += frame("resync", String(latest), resync);
				start = void 0;
			}
			replay(res, start, head).catch((error) => {
				drop(res);
				onError(error);
			});
		},
		clients: () => clients.size,
		close() {
			clearInterval(heartbeat);
			clearTimeout(ingestTimer);
			for (const res of clients.keys()) res.end();
			clients.clear();
		}
	};
}
// packages/engine/src/api/routes.ts
/** Images a browser shows inline; anything else (an SVG, a PDF) is sent as a download, never rendered here. */
const INLINE_MEDIA = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp"
]);
function isInlineMedia(mediaType) {
	return INLINE_MEDIA.has(mediaType);
}
const MAX_LOG = 2 ** 31 - 1;
const MAX_INDEX = 1e8;
const SORTS = [
	"ended",
	"started",
	"cost",
	"calls"
];
const LIFETIME_SORTS = [
	"cost",
	"tokens",
	"calls"
];
const json$1 = (body) => ({
	kind: "json",
	body
});
const found = (value) => {
	if (value === void 0) throw notFound();
	return json$1(value);
};
/** A Session key from its path segments; 404 when it is not there. */
function session(query, p) {
	const key = {
		log: integer$1(p.log ?? "", "log", 0, MAX_LOG),
		id: sessionId(p.id ?? "")
	};
	if (!query.hasSession(key)) throw notFound("no such session");
	return key;
}
function sessionId(text) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(text)) throw badRequest("the session id is not one");
	return text;
}
function hash(text, name) {
	if (!/^[0-9a-f]{16,128}$/.test(text)) throw badRequest(`${name} must be a hex hash`);
	return text;
}
const lifetime = (q) => {
	const sort = q.oneOf("sort", LIFETIME_SORTS);
	const limit = q.int("limit", 1, 1e4);
	return {
		...sort === void 0 ? {} : { sort },
		...limit === void 0 ? {} : { limit }
	};
};
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
/** A Call's Session and index; the index is read first, so a bad one is a 400 before any lookup. */
const call = (query, p) => {
	const n = integer$1(p.n ?? "", "n", 0, MAX_INDEX);
	return [session(query, p), n];
};
const ROUTES = [
	{
		path: ["sessions"],
		params: [
			"project",
			"search",
			"sort",
			"order",
			"changedSince",
			"limit",
			"offset"
		],
		run(query, _p, q) {
			const project = q.text("project");
			const search = q.text("search", 200);
			const sort = q.oneOf("sort", SORTS);
			const order = q.oneOf("order", ["asc", "desc"]);
			const changedSince = q.int("changedSince", 0, Number.MAX_SAFE_INTEGER);
			return json$1(query.listSessions({
				...project === void 0 ? {} : { project },
				...search === void 0 ? {} : { search },
				...sort === void 0 ? {} : { sort },
				...order === void 0 ? {} : { order },
				...changedSince === void 0 ? {} : { changedSince },
				limit: q.int("limit", 1, 500) ?? 50,
				offset: q.int("offset", 0, MAX_INDEX) ?? 0
			}));
		}
	},
	{
		path: ["session-keys"],
		params: ["id"],
		run(query, _p, q) {
			const id = q.text("id", 200);
			if (id === void 0) throw badRequest("id is needed");
			return json$1({
				apiVersion: 1,
				items: query.findSessions(id)
			});
		}
	},
	{
		path: SESSION,
		params: [],
		run: (query, p) => found(query.getSession(session(query, p)))
	},
	{
		path: [...SESSION, "calls"],
		params: [
			"lane",
			"afterIndex",
			"limit"
		],
		run(query, p, q) {
			const key = session(query, p);
			const lane = q.text("lane", 200);
			const afterIndex = q.int("afterIndex", 0, MAX_INDEX);
			const limit = q.int("limit", 1, 5e3);
			return json$1(query.listCalls(key, {
				...lane === void 0 ? {} : { lane },
				...afterIndex === void 0 ? {} : { afterIndex },
				...limit === void 0 ? {} : { limit }
			}));
		}
	},
	{
		path: CALL,
		params: [],
		run: (query, p) => found(query.getCall(...call(query, p)))
	},
	{
		path: [...CALL, "context"],
		params: [],
		run: (query, p) => found(query.contextAt(...call(query, p)))
	},
	{
		path: [...CALL, "diff"],
		params: [],
		run: (query, p) => found(query.contextDiff(...call(query, p)))
	},
	{
		path: [...CALL, "response"],
		params: [],
		run: (query, p) => found(query.responseAt(...call(query, p)))
	},
	{
		path: [...SESSION, "timeline"],
		params: [],
		run: (query, p) => json$1(query.callTimeline(session(query, p)))
	},
	{
		path: [...SESSION, "tool-calls"],
		params: [],
		run: (query, p) => json$1(query.toolCalls(session(query, p)))
	},
	{
		path: [...SESSION, "tool-outputs"],
		params: ["sort", "limit"],
		run: async (query, p, q, offload) => json$1(await offload("toolOutputs", session(query, p), lifetime(q)))
	},
	{
		path: [...SESSION, "blocks"],
		params: ["sort", "limit"],
		run: async (query, p, q, offload) => json$1(await offload("blockLifetimes", session(query, p), lifetime(q)))
	},
	{
		path: [...SESSION, "compactions"],
		params: [],
		run: (query, p) => json$1(query.compactions(session(query, p)))
	},
	{
		path: [...SESSION, "cache-breaks"],
		params: [],
		run: (query, p) => json$1(query.cacheBreaks(session(query, p)))
	},
	{
		path: [
			"blocks",
			":log",
			":hash"
		],
		params: [],
		run(query, p) {
			const [h, log] = [hash(p.hash ?? "", "hash"), integer$1(p.log ?? "", "log", 0, MAX_LOG)];
			return {
				...found(query.getBlock(h, log)),
				tag: `${log}-${h}`
			};
		}
	},
	{
		path: [
			"blocks",
			":log",
			":hash",
			"media",
			":media"
		],
		params: [],
		run(query, p) {
			const [h, log, m] = [
				hash(p.hash ?? "", "hash"),
				integer$1(p.log ?? "", "log", 0, MAX_LOG),
				hash(p.media ?? "", "media")
			];
			const media = query.getMedia(h, log, m);
			if (media === void 0) throw notFound();
			return {
				kind: "media",
				mediaType: media.mediaType,
				bytes: media.bytes,
				tag: `${log}-${h}-${m}`
			};
		}
	},
	{
		path: ["memory"],
		params: ["project"],
		run(query, _p, q) {
			const project = q.text("project");
			if (project === void 0) throw badRequest("project is needed");
			return json$1(query.projectMemory(project));
		}
	},
	{
		path: ["report"],
		params: [],
		run: (query) => json$1(query.ingestReport())
	},
	{
		path: ["projects"],
		params: [],
		run: (query) => json$1(query.listProjects())
	}
];
/** The reply for the decoded segments after `/api/v1/`; 404 for no route. */
function route(query, segments, search, offload) {
	for (const r of ROUTES) {
		if (r.path.length !== segments.length) continue;
		const p = {};
		if (r.path.every((part, i) => {
			const segment = segments[i] ?? "";
			if (part.startsWith(":")) {
				p[part.slice(1)] = checkText(segment, part.slice(1), 256);
				return true;
			}
			return part === segment;
		})) return r.run(query, p, queryParams(search, r.params), offload);
	}
	throw notFound("no such route");
}
// packages/engine/src/api/static.ts
/**
* The viewer's files from one folder: only regular files inside it (after symbolic links are resolved), no folder
* listing, no dot files, a fixed type per extension. A path with no extension that is not a file is a page of the
* single-page viewer: it gets `index.html`.
*/
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm"
};
/** Larger files are not the viewer's; refuse rather than read them into memory. */
const MAX_FILE_BYTES = 33554432;
function staticFiles(dir) {
	const root = realpathSync(dir);
	const inside = (path) => path === root || path.startsWith(root + sep);
	const load = async (relative) => {
		let path;
		try {
			path = await realpath(join(root, ...relative));
		} catch (error) {
			if (missing(error)) return void 0;
			throw error;
		}
		if (!inside(path)) return void 0;
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return void 0;
		const ext = extname(path).toLowerCase();
		return {
			bytes: await readFile(path),
			type: TYPES[ext] ?? "application/octet-stream",
			html: ext === ".html",
			immutable: relative[0] === "assets"
		};
	};
	return { async get(segments) {
		const parts = segments.filter((s) => s !== "");
		if (!parts.every(safeSegment)) return void 0;
		const found = parts.length === 0 ? void 0 : await load(parts);
		if (found !== void 0) return found;
		const last = parts.at(-1);
		if (last !== void 0 && extname(last) !== "") return void 0;
		return load(["index.html"]);
	} };
}
/** A decoded path segment that names a file in the folder: no `..`, no separators, no dot file, no NUL. */
function safeSegment(segment) {
	return !segment.startsWith(".") && !/[/\\\0:]/.test(segment);
}
function missing(error) {
	const code = error.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
// packages/engine/src/api/server.ts
const API_VERSION$1 = 1;
const API_PREFIX = "/api/v1/";
function createApi(options) {
	const { query } = options;
	const now = options.now ?? Date.now;
	const onError = options.onError ?? ((error) => console.error("quantext: a request failed:", error));
	const maxConnections = options.maxConnections ?? 64;
	const idleSocketMs = options.idleSocketMs ?? 15e3;
	const offload = options.offload ?? ((method, key, o) => Promise.resolve(query[method](key, o)));
	const files = staticFiles(options.staticDir);
	const events = createEventStream({
		query,
		onError,
		...options.events
	});
	const info = options.info;
	const health = {
		apiVersion: API_VERSION$1,
		ok: true,
		...info
	};
	const ingestStatus = options.ingestStatus ?? (() => ({
		phase: "live",
		logsDone: 0,
		logsTotal: 0,
		bytesDone: 0,
		bytesTotal: 0,
		startedAt: info.startedAt
	}));
	const status = () => ({
		apiVersion: API_VERSION$1,
		engine: {
			version: info.version,
			pid: info.pid,
			startedAt: info.startedAt
		},
		ingest: ingestStatus(),
		streams: events.clients()
	});
	/** A Block's content never changes under its hash; another engine version may show it differently. */
	const etagOf = (tag) => `"${tag}.${info.version.replace(/[^\w.-]/g, "_")}"`;
	let port = 0;
	let lastActive = now();
	const sockets = /* @__PURE__ */ new Set();
	const handle = async (req, res) => {
		let url;
		try {
			url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		} catch {
			url = void 0;
		}
		const api = url === void 0 || url.pathname === "/api/v1" || url.pathname.startsWith("/api/");
		const refused = refusal(req, port, api || url?.pathname === "/health");
		if (refused !== void 0) return sendError(req, res, refused);
		if (url === void 0) throw badRequest("the URL is not one");
		const segments = decodeSegments(url.pathname);
		if (url.pathname === "/health") return sendJson(req, res, 200, health);
		const touch = () => {
			lastActive = now();
		};
		touch();
		req.on("close", touch);
		res.on("close", touch);
		if (url.pathname === "/api/v1/status") {
			if ([...url.searchParams.keys()].length > 0) throw badRequest("status takes no parameters");
			return sendJson(req, res, 200, status());
		}
		if (url.pathname === "/api/v1/events") {
			if (req.method !== "GET") throw new HttpError(405, "method-not-allowed", "the event stream is GET only");
			const header = req.headers["last-event-id"];
			const last = typeof header === "string" && header !== "" ? header : void 0;
			const cursor = url.searchParams.get("cursor") ?? last;
			for (const name of url.searchParams.keys()) if (name !== "cursor") throw badRequest("the event stream takes only cursor");
			req.socket.setTimeout(0);
			return events.connect(req, res, cursor);
		}
		if (api) {
			if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, "not-found", "no such route");
			const socket = req.socket;
			socket.setTimeout(0);
			const reply = await (async () => route(query, segments.slice(2), url.searchParams, offload))().finally(() => {
				if (!socket.destroyed) socket.setTimeout(idleSocketMs);
			});
			const etag = reply.tag === void 0 ? void 0 : etagOf(reply.tag);
			const cache = etag === void 0 ? {} : {
				"Cache-Control": "no-cache",
				ETag: etag
			};
			if (etag !== void 0 && matches(req.headers["if-none-match"], etag)) {
				res.writeHead(304, {
					...securityHeaders(false),
					...cache
				});
				res.end();
				return;
			}
			if (reply.kind === "json") return sendJson(req, res, 200, reply.body, cache);
			const inline = isInlineMedia(reply.mediaType);
			return sendBytes(req, res, reply.bytes, {
				"Content-Type": inline ? reply.mediaType : "application/octet-stream",
				...cache,
				...inline ? {} : { "Content-Disposition": "attachment" }
			}, false);
		}
		const file = await files.get(segments);
		if (file === void 0) throw new HttpError(404, "not-found", "no such file");
		const cache = file.immutable ? "public, max-age=31536000, immutable" : "no-cache";
		return sendBytes(req, res, file.bytes, {
			"Content-Type": file.type,
			"Cache-Control": cache
		}, file.html);
	};
	const server = createServer({
		maxHeaderSize: 16384,
		headersTimeout: options.headersTimeoutMs ?? 1e4,
		requestTimeout: 3e4,
		keepAliveTimeout: 5e3,
		connectionsCheckingInterval: 500
	}, (req, res) => {
		handle(req, res).catch((error) => {
			if (!(error instanceof HttpError)) onError(error);
			const failure = error instanceof HttpError ? error : new HttpError(500, "internal", "the engine failed");
			if (res.headersSent) res.destroy();
			else sendError(req, res, failure);
		});
	});
	server.timeout = idleSocketMs;
	server.on("connection", (socket) => {
		if (sockets.size >= maxConnections) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return {
		listen(wanted) {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(wanted, "127.0.0.1", () => {
					server.off("error", reject);
					const address = server.address();
					port = typeof address === "object" && address !== null ? address.port : wanted;
					resolve(port);
				});
			});
		},
		publish: (event) => events.publish(event),
		publishIngest: (s) => events.publishIngest(s),
		activity: () => ({
			streams: events.clients(),
			lastActive
		}),
		close() {
			events.close();
			return new Promise((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			});
		}
	};
}
/** Whether an If-None-Match header names this ETag (`*`, or a list of tags, weak or not). */
function matches(header, etag) {
	if (typeof header !== "string") return false;
	return header.split(",").map((t) => t.trim().replace(/^W\//, "")).some((t) => t === etag || t === "*");
}
/** The path's segments, each percent-decoded once; a bad encoding is a 400. */
function decodeSegments(pathname) {
	return pathname.split("/").slice(1).map((s) => {
		try {
			return decodeURIComponent(s);
		} catch {
			throw badRequest("the path is not well encoded");
		}
	});
}
// packages/engine/src/cli/engine-file.ts
/**
* `engine.json` in the data folder: where the running engine listens (ADR 25). It is a hint for a second start
* and for the mod; the writer lock is what keeps one engine per store. Written whole (a temporary file renamed),
* so a reader never sees half of it.
*/
const ENGINE_FILE = "engine.json";
/**
* The engine file, or undefined when there is none or it is not one: another process wrote it, so every field is
* checked, and `url` is never read but built again from the port. A file that cannot be read is no engine
* either; `warn` gets why.
*/
function readEngineFile(dataDir, warn) {
	const path = join(dataDir, ENGINE_FILE);
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT") return void 0;
		if (code === "EACCES" || code === "EISDIR" || code === "EPERM") {
			warn(`cannot read ${path} (${code}); starting as if no engine ran`);
			return;
		}
		throw error;
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const { port, pid, version, apiVersion, startedAt } = value;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return void 0;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return void 0;
	if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) return void 0;
	if (apiVersion !== 1) return void 0;
	return {
		apiVersion,
		version,
		pid,
		port,
		url: engineUrl(port),
		startedAt: typeof startedAt === "string" ? printable(startedAt).slice(0, 64) : ""
	};
}
/** Text from another process, fit for a terminal: each control character (escape codes) becomes `?`. */
function printable(text) {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}
function writeEngineFile(dataDir, file) {
	const path = join(dataDir, ENGINE_FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 384 });
	renameSync(temporary, path);
}
/** Remove the engine file if it still names this process (a later engine may have replaced it). */
function removeEngineFile(dataDir, pid) {
	if (readEngineFile(dataDir, () => void 0)?.pid === pid) rmSync(join(dataDir, ENGINE_FILE), { force: true });
}
/** The engine's address: built from the port alone, so nothing else can reach a browser command line. */
function engineUrl(port) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
	return `http://127.0.0.1:${port}/`;
}
// packages/engine/src/cli/open-url.ts
/** Open a URL in the browser: the platform's opener with the URL as its one argument, never through a shell. */
/** The opener and its arguments. Windows: `start` is a shell built-in, so `rundll32` opens the URL instead. */
function openerFor(platform, url) {
	if (platform === "darwin") return ["open", [url]];
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return ["xdg-open", [url]];
}
/** Open `url`; a failure is passed to `onError` (the engine goes on). */
function openUrl(url, onError) {
	const [command, args] = openerFor(process.platform, url);
	execFile(command, args, {
		shell: false,
		windowsHide: true
	}, (error) => {
		if (error !== null) onError(error);
	}).unref();
}
// packages/engine/src/cli/probe.ts
/** Ask a local port for `/health`, as a second start does before it starts an engine of its own. */
/** The engine's health at 127.0.0.1:`port`, or undefined when nothing answers as an engine in `timeoutMs`. */
function probeHealth(port, timeoutMs = 3e3) {
	return new Promise((resolve) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/health",
			headers: { host: `127.0.0.1:${port}` },
			timeout: timeoutMs
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
				if (body.length > 65536) req.destroy();
			});
			res.on("end", () => resolve(res.statusCode === 200 ? asHealth(body) : void 0));
			res.on("error", () => resolve(void 0));
			res.on("close", () => resolve(void 0));
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(void 0));
		req.end();
	});
}
function asHealth(body) {
	try {
		const h = JSON.parse(body);
		return h?.ok === true && typeof h.version === "string" && typeof h.pid === "number" ? h : void 0;
	} catch {
		return;
	}
}
// packages/engine/src/cli/query-worker-pool.ts
/**
* The engine's side of the query worker (`query-worker.ts`): one worker thread, started on first use, that runs
* the slow query methods, with a time limit per request, a bounded queue, and identical requests shared.
*/
/** `.ts` in the repo, `.js` in the bundle (`dist/query-worker.js`). */
const EXT$1 = import.meta.url.endsWith(".ts") ? "ts" : "js";
/**
* The worker runs one request at a time, sent from a queue here, so that a request that runs too long can be
* stopped (the worker is ended and started again for the next one). Identical requests (method and arguments)
* share one computation, so two tabs on one Session cost one.
*/
function createQueryWorker(options, limits = {}) {
	const timeoutMs = limits.timeoutMs ?? 3e4;
	const maxPending = limits.maxPending ?? 5;
	let worker;
	let next = 0;
	let current;
	let closing = false;
	const queue = [];
	const jobs = /* @__PURE__ */ new Map();
	const settle = (job) => {
		clearTimeout(job.timer);
		jobs.delete(job.key);
	};
	const fail = (job, error) => {
		settle(job);
		job.reject(error);
	};
	/** End the worker on purpose: its exit is no failure. */
	const end = (w) => {
		if (w === void 0) return Promise.resolve();
		if (worker === w) worker = void 0;
		w.removeAllListeners("exit");
		w.removeAllListeners("error");
		return w.terminate().then(() => void 0);
	};
	const started = () => {
		if (worker !== void 0) return worker;
		const w = new Worker(new URL(`./query-worker.${EXT$1}`, import.meta.url), { workerData: options });
		w.on("message", (m) => {
			if (m.id === void 0 || current?.id !== m.id) return;
			const job = current;
			current = void 0;
			settle(job);
			if (m.error !== void 0) job.reject(new Error(m.error));
			else job.resolve(m.result);
			pump();
		});
		const broke = (error) => {
			if (worker === w) worker = void 0;
			for (const job of [...current === void 0 ? [] : [current], ...queue.splice(0)]) fail(job, error);
			current = void 0;
		};
		w.on("error", broke);
		w.on("exit", (code) => broke(/* @__PURE__ */ new Error(`the query worker stopped (exit ${code})`)));
		w.unref();
		worker = w;
		return w;
	};
	const pump = () => {
		if (current !== void 0 || closing) return;
		const job = queue.shift();
		if (job === void 0) return;
		current = job;
		started().postMessage({
			id: job.id,
			method: job.method,
			args: job.args
		});
	};
	const timedOut = (job) => {
		const error = new HttpError(503, "timeout", `the query ran longer than ${Math.round(timeoutMs / 1e3)} s`);
		if (current === job) {
			current = void 0;
			end(worker);
		} else {
			const at = queue.indexOf(job);
			if (at >= 0) queue.splice(at, 1);
		}
		fail(job, error);
		pump();
	};
	const run = ((method, ...args) => {
		if (closing) return Promise.reject(new HttpError(503, "stopping", "the engine is stopping"));
		const key = `${method}\0${JSON.stringify(args)}`;
		const same = jobs.get(key);
		if (same !== void 0) return same.promise;
		if (jobs.size >= maxPending) return Promise.reject(new HttpError(503, "busy", "too many slow queries wait; try again"));
		let resolve;
		let reject;
		const promise = new Promise((y, n) => {
			resolve = y;
			reject = n;
		});
		const job = {
			id: next++,
			key,
			method,
			args,
			promise,
			resolve,
			reject
		};
		job.timer = setTimeout(() => timedOut(job), timeoutMs);
		jobs.set(key, job);
		queue.push(job);
		pump();
		return promise;
	});
	return {
		run,
		async close() {
			closing = true;
			const stopping = new HttpError(503, "stopping", "the engine is stopping");
			for (const job of [...current === void 0 ? [] : [current], ...queue.splice(0)]) fail(job, stopping);
			current = void 0;
			await end(worker);
		}
	};
}
// packages/engine/src/cli/serve.ts
/**
* `qx serve`, the engine process (ADR 25): one per data folder. It reuses an engine that already runs (found by
* `engine.json` and its `/health`), else takes the writer lock, serves the API, catches up on what is new, watches
* the transcripts and passes each change to the event stream. It stops when told (SIGINT, SIGTERM) or, while
* only a viewer needs it, after an idle time; then it stops the watcher after its batch and removes its file.
*/
const API_VERSION = 1;
/** The engine's port when it is free (ADR 25); else any free port, named in `engine.json`. */
const DEFAULT_PORT = 4747;
/** An engine that answers at the port `engine.json` names, with the pid it names. */
async function running(dataDir, version, warn) {
	const file = readEngineFile(dataDir, warn);
	if (file === void 0) return void 0;
	const health = await probeHealth(file.port);
	if (health === void 0 || health.pid !== file.pid) return void 0;
	return health.version === version && health.apiVersion === API_VERSION ? {
		kind: "same",
		file
	} : {
		kind: "other",
		file,
		version: printable(health.version).slice(0, 64)
	};
}
/** Run the engine until it is stopped; returns the exit code. */
async function serve(options, hooks) {
	const { dataDir, version } = options;
	const now = hooks.now ?? Date.now;
	const open = (url) => (hooks.openUrl ?? ((u) => openUrl(u, (e) => hooks.err(`qx: could not open the browser: ${e.message}\n`))))(url);
	const warn = (message) => hooks.err(`qx: ${message}\n`);
	/** Another engine answers: reuse it (0), or say why not (1). */
	const reuse = (found) => {
		if (found.kind === "other") {
			hooks.err(`qx: an engine of version ${found.version} (pid ${found.file.pid}) runs at ${found.file.url}; this is version ${version}. Stop it first (kill ${found.file.pid}).\n`);
			return 1;
		}
		hooks.out(`quantext engine already runs at ${found.file.url} (pid ${found.file.pid})\n`);
		if (options.open) open(found.file.url);
		return 0;
	};
	const before = await running(dataDir, version, warn);
	if (before !== void 0) return reuse(before);
	let store;
	try {
		store = await openStore({ dataDir });
	} catch (error) {
		if (!(error instanceof StoreLockedError)) throw error;
		const until = now() + (hooks.lockWaitMs ?? 5e3);
		while (now() < until) {
			const found = await running(dataDir, version, warn);
			if (found !== void 0) return reuse(found);
			await new Promise((r) => setTimeout(r, 100));
		}
		hooks.err(`qx: ${error.message}\n`);
		return 1;
	}
	const stopping = new AbortController();
	const stopSignal = hooks.signal ?? processSignal(stopping);
	const startedAt = new Date(now()).toISOString();
	let reader;
	let api;
	let watcher;
	let worker;
	let idle;
	let catchUp = Promise.resolve();
	try {
		reader = await openReader(dataDir, { setup: installViews });
		const query = createQuery({
			db: reader,
			codec: claudeCodeCodec
		});
		const ingest = createIngest({
			store,
			root: options.root
		});
		let phase = "catching-up";
		let lastError;
		const ingestStatus = () => ({
			phase,
			...ingest.progress() ?? {
				logsDone: 0,
				logsTotal: 0,
				bytesDone: 0,
				bytesTotal: 0,
				startedAt
			},
			...lastError === void 0 ? {} : { lastError }
		});
		/** Report a failed read on stderr and in the status. */
		const failed = (message) => {
			lastError = message;
			hooks.err(`qx: ${message}\n`);
		};
		const slow = createQueryWorker({ dataDir });
		worker = slow;
		const engineApi = createApi({
			query,
			now,
			offload: slow.run,
			ingestStatus,
			staticDir: hooks.staticDir ?? defaultStaticDir(),
			info: {
				version,
				pid: process.pid,
				startedAt,
				dataDir
			},
			onError: (e) => hooks.err(`qx: ${e instanceof Error ? e.message : String(e)}\n`)
		});
		api = engineApi;
		ingest.onEvent((event) => engineApi.publish(event));
		ingest.onProgress(() => engineApi.publishIngest(ingestStatus()));
		const enter = (next) => {
			phase = next;
			engineApi.publishIngest(ingestStatus());
		};
		const port = await listen(engineApi, options.port, hooks.defaultPort ?? 4747);
		const url = engineUrl(port);
		writeEngineFile(dataDir, {
			apiVersion: API_VERSION,
			version,
			pid: process.pid,
			port,
			url,
			startedAt
		});
		hooks.out(`quantext engine at ${url} (pid ${process.pid})\n`);
		if (options.open) open(url);
		const stopped = new Promise((resolve) => {
			const done = (why) => {
				stopping.abort();
				resolve(why);
			};
			if (stopSignal.aborted) done("stopped");
			stopSignal.addEventListener("abort", () => done("stopped"), { once: true });
			if (options.live === "while-viewer") {
				const idleMs = options.idleMinutes * 6e4;
				idle = setInterval(() => {
					const { streams, lastActive } = engineApi.activity();
					if (streams === 0 && now() - lastActive >= idleMs) done(`idle for ${options.idleMinutes} min`);
					else hooks.onIdleCheck?.();
				}, hooks.idleCheckMs ?? 15e3);
			}
		});
		catchUp = ingest.ingestAll({ signal: stopping.signal }).then((summary) => {
			for (const e of summary.errors) failed(`${e.path}: ${e.error}`);
			if (!stopping.signal.aborted) {
				enter("live");
				watcher = watchTranscripts({
					ingest,
					root: options.root,
					onError: (e) => failed(`live ingest failed: ${e instanceof Error ? e.message : String(e)}`)
				});
			}
		});
		catchUp.catch((e) => failed(`ingest failed: ${e instanceof Error ? e.message : String(e)}`));
		const why = await stopped;
		enter("stopping");
		hooks.out(`quantext engine stopping (${why})\n`);
		return 0;
	} finally {
		clearInterval(idle);
		stopping.abort();
		await catchUp.catch(() => void 0);
		await watcher?.stop();
		await api?.close();
		await worker?.close();
		reader?.close();
		store.close();
		removeEngineFile(dataDir, process.pid);
	}
}
/** Listen on the asked port, or on the default port, else on any free one. */
async function listen(api, asked, fallback) {
	const inUse = (error) => error.code === "EADDRINUSE";
	try {
		return await api.listen(asked ?? fallback);
	} catch (error) {
		if (!inUse(error)) throw error;
		if (asked !== void 0) throw new Error(`port ${asked} is in use (--port)`);
		return api.listen(0);
	}
}
/** Abort on SIGINT or SIGTERM; a second signal ends the process at once. */
function processSignal(controller) {
	const signals = ["SIGINT", "SIGTERM"];
	const onSignal = () => {
		if (controller.signal.aborted) process.exit(130);
		controller.abort();
	};
	for (const s of signals) process.on(s, onSignal);
	controller.signal.addEventListener("abort", () => {
		setTimeout(() => {
			for (const s of signals) process.off(s, onSignal);
		}, 1e4).unref();
	});
	return controller.signal;
}
/**
* The viewer's files: `web/` next to the bundled engine; from source, the viewer's Vite build when there is one,
* else the placeholder folder in the repo.
*/
function defaultStaticDir() {
	for (const candidate of [
		"./web/",
		"../../../web/dist/",
		"../../static/"
	]) {
		const dir = fileURLToPath(new URL(candidate, import.meta.url));
		if (existsSync(`${dir}index.html`)) return dir;
	}
	throw new Error("the viewer's files are missing (no web/index.html next to the engine)");
}
// packages/engine/src/cli/version.ts
/**
* The release version, from the root package.json: its one source (ADR 30). The bundler inlines only this
* string, so the engine reports the same version run from source or from `dist/engine.js`.
*/
const VERSION = "0.1.0";
// packages/engine/src/cli/main.ts
/**
* The `qx` command: ingest the transcripts, and read the store through the query layer (or SQL, read-only).
* `main` takes its arguments and I/O from the caller, so tests run it in-process. Exit codes are in `EXIT`.
*/
/** 0: done. 1: failed (no store, a store or SQL error). 2: wrong use (arguments, a rejected statement). 3: not found. */
const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	notFound: 3
};
const USAGE = `qx: what the model received on every call, from the local session logs.

Usage:
  qx ingest [--root <dir>]                      Read new transcript bytes into the store
  qx sessions [--project <p>] [--search <s>] [--sort ended|started|cost|calls] [--limit <n>] [--offset <n>]
  qx session <id>                               A Session: lanes, compactions, events, subagents
  qx call <session> <n> [--lane <lane>] [--diff]
                                                The context of Call n (its index in the Session; with --lane, the
                                                n-th Call of that lane), and with --diff its change from the last
  qx outputs <session> [--sort cost|tokens|calls] [--limit <n>]
                                                The Session's tool outputs by lifetime cost
  qx blocks <session> [--sort cost|tokens|calls] [--limit <n>]
                                                The Session's Blocks by lifetime cost
  qx sql "<select>" [--limit <n>] [--timeout <s>]
                                                One read-only statement over the tables and views, in its own
                                                process, stopped after --timeout seconds (default 30)
  qx report                                     What ingest could not read or map, and the Calls' issues
  qx serve [--root <dir>] [--port <n>] [--live while-viewer|always] [--idle-minutes <n>] [--open]
                                                The engine: the viewer and the HTTP API on 127.0.0.1 (port
                                                ${DEFAULT_PORT}, else a free one), live ingest; reuses a running
                                                engine. Stops after --idle-minutes (default 10) with
                                                no viewer, unless --live always
  qx --version | --help

Options for every command:
  --data-dir <dir>      The store's folder (default ~/.quantext)
  --json                JSON output: the query layer's response types (docs/cli.md)

Exit codes: 0 done, 1 failed, 2 wrong use, 3 not found.`;
var UsageError = class extends Error {};
var NotFoundError = class extends Error {};
const OPTIONS = {
	"data-dir": { type: "string" },
	root: { type: "string" },
	json: { type: "boolean" },
	project: { type: "string" },
	search: { type: "string" },
	sort: { type: "string" },
	limit: { type: "string" },
	offset: { type: "string" },
	lane: { type: "string" },
	diff: { type: "boolean" },
	timeout: { type: "string" },
	port: { type: "string" },
	live: { type: "string" },
	"idle-minutes": { type: "string" },
	open: { type: "boolean" },
	version: { type: "boolean" },
	help: {
		type: "boolean",
		short: "h"
	}
};
function parse(argv) {
	return parseArgs({
		args: [...argv],
		options: OPTIONS,
		allowPositionals: true,
		strict: true
	});
}
/** Run `qx` with these arguments; returns the exit code. */
async function main(argv, io) {
	try {
		let parsed;
		try {
			parsed = parse(argv);
		} catch (error) {
			throw new UsageError(error instanceof Error ? error.message : String(error));
		}
		const { values, positionals } = parsed;
		if (values.version === true) {
			io.stdout(`qx ${VERSION} (store schema ${SCHEMA_VERSION})\n`);
			return EXIT.ok;
		}
		if (values.help === true) {
			io.stdout(`${USAGE}\n`);
			return EXIT.ok;
		}
		const [command, ...args] = positionals;
		if (command === void 0) throw new UsageError("no command given");
		const dataDir = values["data-dir"] ?? defaultDataDir(io.home);
		if (command === "ingest") return await ingest(values, args, dataDir, io);
		if (command === "sql") return await sql(values, args, dataDir, io);
		if (command === "serve") return await serveCommand(values, args, dataDir, io);
		const run = COMMANDS[command];
		if (run === void 0) throw new UsageError(`unknown command: ${command}`);
		const db = await openReader(dataDir, { setup: installViews });
		try {
			return run({
				values,
				args,
				query: createQuery({
					db,
					codec: claudeCodeCodec
				}),
				db,
				io
			});
		} finally {
			db.close();
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`qx: ${error.message}\n\n${USAGE}\n`);
			return EXIT.usage;
		}
		if (error instanceof SqlRejectedError) {
			io.stderr(`qx: ${error.message}\n`);
			return EXIT.usage;
		}
		if (error instanceof NotFoundError) {
			io.stderr(`qx: ${error.message}\n`);
			return EXIT.notFound;
		}
		io.stderr(`qx: ${error instanceof Error ? error.message : String(error)}\n`);
		return EXIT.failed;
	}
}
const COMMANDS = {
	sessions({ values, args, query, io }) {
		arity(args, 0, "sessions");
		const sort = values.sort;
		if (sort !== void 0 && ![
			"ended",
			"started",
			"cost",
			"calls"
		].includes(sort)) throw new UsageError(`--sort must be ended, started, cost or calls, not ${sort}`);
		const page = query.listSessions({
			...values.project === void 0 ? {} : { project: values.project },
			...values.search === void 0 ? {} : { search: values.search },
			...sort === void 0 ? {} : { sort },
			limit: integer(values.limit, "--limit") ?? 50,
			offset: integer(values.offset, "--offset") ?? 0
		});
		io.stdout(values.json === true ? json(page) : printSessions(page));
		return EXIT.ok;
	},
	session({ values, args, query, io }) {
		arity(args, 1, "session <id>");
		const detail = query.getSession(resolve(query, args[0] ?? ""));
		if (detail === void 0) throw new NotFoundError(`no session ${args[0]}`);
		io.stdout(values.json === true ? json(detail) : printSession(detail));
		return EXIT.ok;
	},
	call({ values, args, query, io }) {
		arity(args, 2, "call <session> <n>");
		const key = resolve(query, args[0] ?? "");
		const n = integer(args[1], "<n>") ?? 0;
		let index = n;
		if (values.lane !== void 0) {
			const calls = query.listCalls(key, { lane: values.lane });
			const call = calls.items[n];
			if (call === void 0) throw new NotFoundError(`lane ${values.lane} has ${calls.total} calls, no call ${n}`);
			index = call.index;
		}
		const context = query.contextAt(key, index);
		if (context === void 0) throw new NotFoundError(`session ${key.id} has no call ${index}`);
		const diff = values.diff === true ? query.contextDiff(key, index) : void 0;
		io.stdout(values.json === true ? json(diff === void 0 ? context : {
			...context,
			diff
		}) : printCall(context, diff));
		return EXIT.ok;
	},
	outputs({ values, args, query, io }) {
		arity(args, 1, "outputs <session>");
		const list = query.toolOutputs(resolve(query, args[0] ?? ""), lifetimeOptions(values));
		io.stdout(values.json === true ? json(list) : printToolOutputs(list.items));
		return EXIT.ok;
	},
	blocks({ values, args, query, io }) {
		arity(args, 1, "blocks <session>");
		const list = query.blockLifetimes(resolve(query, args[0] ?? ""), lifetimeOptions(values));
		io.stdout(values.json === true ? json(list) : printBlockLifetimes(list.items));
		return EXIT.ok;
	},
	report({ values, args, query, io }) {
		arity(args, 0, "report");
		const report = query.ingestReport();
		io.stdout(values.json === true ? json(report) : printReport(report));
		return EXIT.ok;
	}
};
/** In the repo the files are `.ts`; in the bundle (`dist/`), each entry is a `.js` file next to the engine. */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";
const SQL_CHILD = fileURLToPath(new URL(`./sql-child.${EXT}`, import.meta.url));
/** `qx sql`: the statement runs in a child process, killed after the time limit. */
async function sql(values, args, dataDir, io) {
	arity(args, 1, "sql \"<select>\"");
	const limit = integer(values.limit, "--limit") ?? 1e3;
	const timeout = integer(values.timeout, "--timeout") ?? 30;
	const reply = await runChild(JSON.stringify({
		dataDir,
		sql: args[0] ?? "",
		limit
	}), timeout * 1e3);
	if (reply === "timeout") {
		io.stderr(`qx: the query ran longer than ${timeout} s and was stopped (--timeout)\n`);
		return EXIT.failed;
	}
	const parsed = JSON.parse(reply);
	if (parsed.result === void 0) {
		io.stderr(`qx: ${parsed.error ?? "the query failed"}\n`);
		return parsed.rejected === true ? EXIT.usage : EXIT.failed;
	}
	io.stdout(values.json === true ? json(parsed.result) : printSql(parsed.result));
	return EXIT.ok;
}
/** Run the SQL child with `input` on stdin; its stdout, or "timeout" when it was killed after `ms`. */
function runChild(input, ms) {
	const flags = process.versions.bun === void 0 ? ["--no-warnings"] : [];
	const child = spawn(process.execPath, [
		...flags,
		SQL_CHILD,
		String(ms + 1e3)
	], { stdio: [
		"pipe",
		"pipe",
		"pipe"
	] });
	const forward = () => child.kill("SIGKILL");
	const signals = [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	];
	for (const signal of signals) process.once(signal, forward);
	const done = () => {
		for (const signal of signals) process.off(signal, forward);
	};
	return new Promise((resolve, reject) => {
		let out = "";
		let err = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, ms);
		child.stdout.on("data", (d) => out += d.toString("utf8"));
		child.stderr.on("data", (d) => err += d.toString("utf8"));
		child.on("error", (error) => {
			clearTimeout(timer);
			done();
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			done();
			if (signal !== null && !killed) {
				reject(/* @__PURE__ */ new Error(`the SQL process was stopped (${signal})`));
				return;
			}
			if (killed) resolve("timeout");
			else if (code === 0 && out !== "") resolve(out);
			else reject(/* @__PURE__ */ new Error(`the SQL process failed (exit ${code}): ${err.trim()}`));
		});
		child.stdin.end(input);
	});
}
async function ingest(values, args, dataDir, io) {
	arity(args, 0, "ingest");
	const root = values.root ?? claudeConfigDir(io.env, io.home);
	let store;
	try {
		store = await openStore({ dataDir });
	} catch (error) {
		if (error instanceof StoreLockedError) {
			io.stderr(`qx: ${error.message}\n`);
			return EXIT.failed;
		}
		throw error;
	}
	try {
		const started = performance.now();
		const summary = await createIngest({
			store,
			root
		}).ingestAll();
		const ms = Math.round(performance.now() - started);
		if (values.json === true) io.stdout(json({
			...summary,
			ms
		}));
		else io.stdout(`${summary.logs} logs, ${summary.files} files with new bytes, ${summary.bytes} bytes read, ${summary.callsAdded} calls added, in ${ms} ms\n`);
		for (const e of summary.errors) io.stderr(`qx: ${e.path}: ${e.error}\n`);
		return EXIT.ok;
	} finally {
		store.close();
	}
}
async function serveCommand(values, args, dataDir, io) {
	arity(args, 0, "serve");
	const live = values.live ?? "while-viewer";
	if (live !== "while-viewer" && live !== "always") throw new UsageError(`--live must be while-viewer or always, not ${live}`);
	const port = integer(values.port, "--port");
	if (port !== void 0 && port > 65535) throw new UsageError("--port must be from 0 to 65535");
	const idleMinutes = integer(values["idle-minutes"], "--idle-minutes") ?? 10;
	if (idleMinutes < 1) throw new UsageError("--idle-minutes must be at least 1");
	return serve({
		dataDir,
		root: values.root ?? claudeConfigDir(io.env, io.home),
		version: VERSION,
		...port === void 0 ? {} : { port },
		live,
		idleMinutes,
		open: values.open === true
	}, {
		out: io.stdout,
		err: io.stderr,
		...io.serve
	});
}
/** A Session by its id, an id prefix, or `<log>:<id>` where the same id is in more than one log. */
function resolve(query, text) {
	const at = /^(\d+):(.+)$/.exec(text);
	const found = at === null ? query.findSessions(text) : query.findSessions(at[2] ?? "").filter((k) => k.log === Number(at[1]));
	const exact = found.filter((k) => k.id === (at === null ? text : at[2]));
	const matches = exact.length > 0 ? exact : found;
	if (matches.length === 0) throw new NotFoundError(`no session ${text}`);
	if (matches.length > 1) throw new UsageError(`${text} names more than one session: ${matches.map((k) => `${k.log}:${k.id}`).join(", ")}`);
	return matches[0];
}
function lifetimeOptions(values) {
	const sort = values.sort;
	if (sort !== void 0 && ![
		"cost",
		"tokens",
		"calls"
	].includes(sort)) throw new UsageError(`--sort must be cost, tokens or calls, not ${sort}`);
	return {
		...sort === void 0 ? {} : { sort },
		limit: integer(values.limit, "--limit") ?? 20
	};
}
function arity(args, n, usage) {
	if (args.length !== n) throw new UsageError(`usage: qx ${usage}`);
}
function integer(text, name) {
	if (text === void 0) return void 0;
	if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a whole number, not ${text}`);
	return Number(text);
}
function json(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
// packages/engine/src/cli/qx.ts
process.exitCode = await main(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	env: process.env,
	home: homedir()
});
export {};
