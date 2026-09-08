/**
 * Live feature test for the INSTALLED bedrock-vscode-chat extension.
 *
 * Loads the extension's own compiled modules out of the installed extension
 * directory (not the repo build) and drives them against real Bedrock, so what
 * is verified is the artifact that VS Code will actually run.
 *
 * A tiny `vscode` stub is injected because tool-buffer/stream-processor/logger
 * require it at runtime for the response-part classes and the output channel.
 */
const Module = require("node:module");
const path = require("node:path");
const assert = require("node:assert");

// Defaults to this repo's own build. Point EXT_DIR at an installed extension
// directory to verify the artifact VS Code actually loaded, e.g.
//   EXT_DIR=~/.vscode-server/extensions/arifum.bedrock-vscode-chat-0.0.6
const EXT = process.env.EXT_DIR || path.resolve(__dirname, "..");
const OUT = path.join(EXT, "out");

if (!require("node:fs").existsSync(OUT)) {
	console.error(`No compiled output at ${OUT}. Run \`npm run compile\` first.`);
	process.exit(2);
}
if (!process.env.AWS_BEARER_TOKEN_BEDROCK && !process.env.AWS_PROFILE) {
	console.error("Set AWS_BEARER_TOKEN_BEDROCK (or AWS_PROFILE) — this harness makes real Bedrock calls.");
	process.exit(2);
}

/* ---------------------------------------------------------------- vscode stub */

class LanguageModelTextPart {
	constructor(value) { this.value = value; }
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelThinkingPart {
	constructor(value) { this.value = value; }
}

const logLines = [];
const vscodeStub = {
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	// Deliberately absent by default so `native` display degrades as it does on
	// VS Code stable. Test 11 adds it to prove the runtime probe finds it.
	window: {
		createOutputChannel: () => ({
			appendLine: (l) => logLines.push(l),
			append: (l) => logLines.push(l),
			show: () => {}, dispose: () => {}, clear: () => {},
		}),
	},
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
};

// The modules bind `vscode` with __importStar, which COPIES the namespace at
// require time — so the Insiders case must be set up before the first require,
// not mutated in afterwards. Driven by env var so one harness covers both.
const INSIDERS = process.env.STUB_THINKING_API === "1";
if (INSIDERS) { vscodeStub.LanguageModelThinkingPart = LanguageModelThinkingPart; }

const origLoad = Module._load;
Module._load = function (request) {
	if (request === "vscode") { return vscodeStub; }
	return origLoad.apply(this, arguments);
};

/* ------------------------------------------------------- installed ext modules */

const { getModelProfile, parseClaudeVersion } = require(path.join(OUT, "profiles.js"));
const { buildRequestInput, minMaxTokensForEffort } = require(path.join(OUT, "converters/request.js"));
const {
	describeThinkingBudgetConflict,
	explainBedrockValidationError,
} = require(path.join(OUT, "validation.js"));
const { applyCachePoints } = require(path.join(OUT, "converters/cache-points.js"));
const { StreamProcessor } = require(path.join(OUT, "stream-processor.js"));
const { UsageTracker } = require(path.join(OUT, "usage-tracker.js"));
const { getThinkingPartCtor, resetThinkingPartCache, createThinkingReporter } = require(path.join(OUT, "thinking.js"));
const { BedrockClient } = require(path.join(OUT, "clients/bedrock.client.js"));
const {
	THINKING_EFFORTS, encodeVariantId, decodeVariantId, resolveThinkingForTurn,
} = require(path.join(OUT, "thinking-variants.js"));
const { expandEffortVariants } = require(path.join(OUT, "services/model.service.js"));

const {
	BedrockRuntimeClient, ConverseStreamCommand,
} = require(path.join(EXT, "node_modules/@aws-sdk/client-bedrock-runtime"));

/* ------------------------------------------------------------------- test rig */

const REGION = process.env.AWS_REGION || "us-west-2";
const CHEAP = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ADAPTIVE = "global.anthropic.claude-sonnet-4-6";

const results = [];
let spend = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

/** ONLY=<substring> restricts the run, so the Insiders pass costs no API calls. */
const ONLY = process.env.ONLY;

async function test(name, fn) {
	if (ONLY && !name.includes(ONLY)) { return; }
	const t0 = Date.now();
	try {
		const note = await fn();
		results.push({ name, ok: true, ms: Date.now() - t0, note });
		console.log(`PASS  ${name}${note ? "  — " + note : ""}`);
	} catch (err) {
		results.push({ name, ok: false, ms: Date.now() - t0, note: err.message });
		console.log(`FAIL  ${name}\n        ${err.message}`);
	}
}

/** Collects what the provider reports to VS Code. */
function makeProgress() {
	const parts = [];
	return {
		parts,
		report: (p) => parts.push(p),
		text: () => parts.filter((p) => p instanceof LanguageModelTextPart).map((p) => p.value).join(""),
		toolCalls: () => parts.filter((p) => p instanceof LanguageModelToolCallPart),
	};
}
const noCancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

/** Send a built request through the real StreamProcessor. */
async function run(input, opts = {}) {
	const client = new BedrockRuntimeClient({ region: REGION });
	const res = await client.send(new ConverseStreamCommand(input));
	const progress = makeProgress();
	const result = await new StreamProcessor().processStream(res.stream, progress, noCancel, opts);
	spend.calls++;
	spend.in += result.usage?.inputTokens ?? 0;
	spend.out += result.usage?.outputTokens ?? 0;
	spend.cacheRead += result.usage?.cacheReadInputTokens ?? 0;
	spend.cacheWrite += result.usage?.cacheWriteInputTokens ?? 0;
	return { result, progress };
}

/* Fixtures --------------------------------------------------------------- */

const model = (id, maxOut) => ({ id, maxOutputTokens: maxOut });
const userMsg = (t) => ({ role: "user", content: [{ text: t }] });

/** A system prompt large enough to clear Anthropic's minimum cacheable prefix. */
const BIG_SYSTEM = Array.from({ length: 90 }, (_, i) =>
	`Rule ${i + 1}: When responding, prefer precision over brevity, cite the specific ` +
	`file and line when referring to code, never invent an API that you have not seen ` +
	`in the provided context, and if a request is ambiguous state the assumption you ` +
	`are making rather than asking a clarifying question. This rule is numbered ${i + 1} ` +
	`and exists to make the system prompt long enough to be worth caching.`
).join("\n");

const TOOLS = {
	tools: [{
		toolSpec: {
			name: "write_file",
			description: "Write text content to a file at the given path, replacing it entirely.",
			inputSchema: { json: {
				type: "object",
				properties: {
					path: { type: "string", description: "Repo-relative file path" },
					content: { type: "string", description: "Full file contents to write" },
				},
				required: ["path", "content"],
			} },
		},
	}],
};

const NO_PARAM_TOOL = {
	tools: [{
		toolSpec: {
			name: "get_current_time",
			description: "Returns the current server time. Takes no arguments.",
			inputSchema: { json: { type: "object", properties: {} } },
		},
	}],
};

/* ============================================================== OFFLINE TESTS */

async function main() {
console.log(`\n--- Offline: real compiled code from the installed extension ---\n`);

await test("#25 root cause: maxTokens defaults to the model ceiling, not 4096", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 64000),
		converted: { messages: [userMsg("hi")], system: [] },
		options: {},                       // Copilot sends no max_tokens — the bug trigger
		profile: getModelProfile(CHEAP),
	});
	const got = built.input.inferenceConfig.maxTokens;
	assert.strictEqual(got, 64000, `expected 64000, got ${got}`);
	assert.notStrictEqual(got, 4096, "still pinned at the old 4096 default");
	return `maxTokens=${got}`;
});

await test("maxOutputTokens override is honoured and clamped to the ceiling", async () => {
	const low = buildRequestInput({
		model: model(CHEAP, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 500,
	});
	assert.strictEqual(low.input.inferenceConfig.maxTokens, 500);
	const over = buildRequestInput({
		model: model(CHEAP, 8192), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 999999,
	});
	assert.strictEqual(over.input.inferenceConfig.maxTokens, 8192, "override must not exceed the model");
	return "500 honoured; 999999 clamped to 8192";
});

await test("a maxOutputTokens setting of 0 resolves to the model ceiling, not 1", async () => {
	// The setting's own default is 0, documented as "use the model maximum", but
	// it was selected with `?? ceiling`, which does not treat 0 as absent. A
	// literal 0 therefore won and every request Copilot sent no max_tokens with
	// went out as maxTokens: 1. This exact value was the one never tested.
	for (const sentinel of [0, undefined, -1]) {
		const built = buildRequestInput({
			model: model(CHEAP, 64000), converted: { messages: [userMsg("hi")], system: [] },
			options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: sentinel,
		});
		assert.strictEqual(built.input.inferenceConfig.maxTokens, 64000, `sentinel ${String(sentinel)} leaked`);
		assert.strictEqual(built.maxTokens.source, "model-ceiling");
	}
	return "0 / undefined / -1 all fall through to the ceiling";
});

await test("default settings + thinking produce a valid max_tokens/budget pair", async () => {
	// The reported failure: maxOutputTokens unset, thinking on at effort high.
	// Bedrock rejected it with "max_tokens must be greater than
	// thinking.budget_tokens" because maxTokens had resolved to 1.
	const notes = [];
	for (const [id, ceiling] of [[ADAPTIVE, 64000], [CHEAP, 32000]]) {
		const built = buildRequestInput({
			model: model(id, ceiling), converted: { messages: [userMsg("hi")], system: [] },
			options: {}, profile: getModelProfile(id), maxOutputTokensOverride: 0,
			thinking: { enabled: true, effort: "high", budgetTokens: 0 },
		});
		assert.strictEqual(built.thinkingEnabled, true, `${id}: thinking must survive`);
		assert.strictEqual(built.maxTokens.conflict, undefined, `${id}: unexpected conflict`);
		const max = built.input.inferenceConfig.maxTokens;
		const budget = built.input.additionalModelRequestFields.reasoning_config?.budget_tokens;
		assert.ok(max >= minMaxTokensForEffort("high"), `${id}: maxTokens ${max} has no headroom`);
		if (budget !== undefined) {
			assert.ok(budget < max, `${id}: budget ${budget} >= maxTokens ${max}`);
		}
		notes.push(`${id.split(".").pop()}: max=${max}${budget ? ` budget=${budget}` : " (adaptive)"}`);
	}
	return notes.join("; ");
});

await test("an explicit cap too small for the effort is reported, not sent invalid", async () => {
	const built = buildRequestInput({
		model: model(ADAPTIVE, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(ADAPTIVE), maxOutputTokensOverride: 500,
		thinking: { enabled: true, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(built.input.inferenceConfig.maxTokens, 500, "an explicit cap stays honoured");
	assert.strictEqual(built.thinkingEnabled, false, "thinking must be dropped, not sent invalid");
	assert.ok(built.maxTokens.conflict, "the impossible pair must be reported to the caller");
	assert.strictEqual(built.input.additionalModelRequestFields, undefined);
	return `conflict surfaced; needs >= ${built.maxTokens.conflict.requiredMaxTokens}`;
});

await test("invariant: no effort/API/setting/request combination yields an invalid pair", async () => {
	// Property-style sweep, because every bug in this area has been a single point
	// in this space that example-based tests happened to miss. `request` is a
	// dimension because Copilot supplies its own small max_tokens for utility
	// calls, and that is where the adaptive API broke.
	let n = 0;
	for (const id of [ADAPTIVE, CHEAP]) {
		for (const effort of THINKING_EFFORTS) {
			for (const setting of [0, 1, 500, 1024, 4096, 32000, 999999, undefined]) {
				for (const request of [undefined, 500, 3000, 8192, 20480]) {
				for (const ceiling of [8192, 32000, 128000]) {
					n++;
					const built = buildRequestInput({
						model: model(id, ceiling), converted: { messages: [userMsg("hi")], system: [] },
						options: request === undefined ? {} : { modelOptions: { max_tokens: request } },
						profile: getModelProfile(id), maxOutputTokensOverride: setting,
						thinking: { enabled: true, effort, budgetTokens: 0 },
					});
					const where = `${id} ${effort} setting=${String(setting)} request=${String(request)} ceiling=${ceiling}`;
					const max = built.input.inferenceConfig.maxTokens;
					assert.ok(max >= 1 && max <= ceiling, `${where}: maxTokens ${max} out of range`);
					const fields = built.input.additionalModelRequestFields;
					const budget = fields?.reasoning_config?.budget_tokens;
					if (built.thinkingEnabled) {
						assert.ok(max >= 2048, `${where}: thinking on with only ${max} output tokens`);
						if (budget !== undefined) {
							assert.ok(budget >= 1024, `${where}: budget ${budget} below Anthropic's floor`);
							assert.ok(budget < max, `${where}: budget ${budget} >= maxTokens ${max}`);
						}
						// The adaptive API sends no budget, so the level it does send must be
						// one whose server-derived budget fits, and never above what was asked.
						if (getModelProfile(id).thinkingApi === "adaptive") {
							const sent = fields.output_config.effort;
							assert.ok(
								max >= minMaxTokensForEffort(sent),
								`${where}: sent "${sent}" needing ${minMaxTokensForEffort(sent)} with only ${max}`
							);
							assert.ok(
								THINKING_EFFORTS.indexOf(sent) <= THINKING_EFFORTS.indexOf(effort),
								`${where}: effort raised to "${sent}"`
							);
						}
					} else {
						assert.strictEqual(budget, undefined, `${where}: budget sent with thinking off`);
						// Thinking is dropped either because an explicit cap conflicts, or
						// because the adaptive API has no level small enough to fit: its
						// budget is derived server-side from the effort, so there is nothing
						// to trim when even "low" does not fit.
						const adaptiveTooSmall =
							getModelProfile(id).thinkingApi === "adaptive" && max < minMaxTokensForEffort("low");
						assert.ok(
							built.maxTokens.conflict || adaptiveTooSmall,
							`${where}: thinking dropped with no explanation`
						);
					}
				}
				}
			}
		}
	}
	return `${n} combinations, all valid`;
});

await test("thinking budget conflicts are explained in terms of settings", async () => {
	const msg = describeThinkingBudgetConflict({
		maxTokens: 500, requiredMaxTokens: 20480, effort: "high", source: "setting", ceiling: 128000,
	});
	assert.ok(msg.includes("maxOutputTokens"), "must name the setting the user can change");
	assert.ok(msg.includes("high"), "must name the effort level");

	// The exact string Bedrock returned in the report.
	const raw = "The model returned the following errors: `max_tokens` must be greater than `thinking.budget_tokens`.";
	const explained = explainBedrockValidationError(raw, { maxTokens: 1, effort: "high", thinkingEnabled: true });
	assert.ok(explained, "the reported Bedrock error must be recognized");
	assert.ok(explained.includes("maxOutputTokens"), "must translate to a setting name");
	assert.ok(explained.includes(raw), "must preserve the original for diagnosis");

	assert.strictEqual(
		explainBedrockValidationError("AccessDeniedException: not authorized", { thinkingEnabled: true }),
		undefined, "unrelated errors must pass through untouched"
	);
	return "conflict + Bedrock rejection translated; unrelated untouched";
});

await test("profiles: caching + thinking API detected per model", async () => {
	const h = getModelProfile(CHEAP);
	assert.strictEqual(h.supportsPromptCaching, true);
	assert.strictEqual(h.maxCachePoints, 4);
	assert.strictEqual(h.supportsTemperature, false, "Claude 4.5 must omit temperature");
	assert.strictEqual(h.thinkingApi, "budget");
	const s = getModelProfile(ADAPTIVE);
	assert.strictEqual(s.thinkingApi, "adaptive", "Claude 4.6 must use the adaptive API");
	const old = getModelProfile("anthropic.claude-3-haiku-20240307-v1:0");
	assert.strictEqual(old.supportsPromptCaching, false, "Claude 3 Haiku must not get cachePoints");
	assert.strictEqual(old.supportsTemperature, true, "legacy model keeps temperature");
	return "haiku4.5=budget/cacheable, sonnet4.6=adaptive, claude3=fail-closed";
});

await test("cross-region prefix stripping (global./us.)", async () => {
	assert.strictEqual(getModelProfile("global.anthropic.claude-sonnet-4-6").supportsTemperature, false);
	assert.strictEqual(getModelProfile("us.anthropic.claude-opus-5").supportsPromptCaching, true);
	assert.deepStrictEqual(parseClaudeVersion("global.anthropic.claude-sonnet-4-6"), { major: 4, minor: 6 });
	return "global./us. resolve to the base model";
});

await test("#19 cache points: 4 inserted on a large prefix, 0 when too short", async () => {
	const big = applyCachePoints(
		{ messages: [userMsg(BIG_SYSTEM), { role: "assistant", content: [{ text: "ok" }] }, userMsg("go")],
		  system: [{ text: BIG_SYSTEM }], toolConfig: TOOLS },
		getModelProfile(CHEAP), true);
	assert.strictEqual(big.inserted, 4, `expected 4 checkpoints, got ${big.inserted}`);
	assert.ok(big.toolConfig.tools.some((t) => t.cachePoint), "tool schemas uncached");
	assert.ok(big.system.some((s) => s.cachePoint), "system prompt uncached");
	const marked = big.messages.filter((m) => m.content.some((c) => c.cachePoint));
	assert.strictEqual(marked.length, 2, "expected the trailing PAIR of user messages marked");

	const small = applyCachePoints({ messages: [userMsg("hi")], system: [{ text: "be nice" }] },
		getModelProfile(CHEAP), true);
	assert.strictEqual(small.inserted, 0, "short prompt must not pay for a refused checkpoint");

	const off = applyCachePoints(
		{ messages: [userMsg(BIG_SYSTEM)], system: [{ text: BIG_SYSTEM }], toolConfig: TOOLS },
		getModelProfile(CHEAP), false);
	assert.strictEqual(off.inserted, 0, "toggle off must insert nothing");
	return "4 on long prefix; 0 short; 0 when toggled off";
});

await test("thinking config: adaptive vs budget wire shape", async () => {
	const ad = buildRequestInput({
		model: model(ADAPTIVE, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: { modelOptions: { temperature: 0.9, top_p: 0.5 } },
		profile: getModelProfile(ADAPTIVE),
		thinking: { enabled: true, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(ad.thinkingEnabled, true);
	assert.deepStrictEqual(ad.input.additionalModelRequestFields.thinking, { type: "adaptive" });
	assert.deepStrictEqual(ad.input.additionalModelRequestFields.output_config, { effort: "high" });
	assert.strictEqual(ad.input.inferenceConfig.temperature, undefined, "temperature must be suppressed");
	assert.strictEqual(ad.input.inferenceConfig.topP, undefined, "topP must be suppressed");

	const bud = buildRequestInput({
		model: model(CHEAP, 8192), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP),
		thinking: { enabled: true, effort: "xhigh", budgetTokens: 0 },
	});
	const rc = bud.input.additionalModelRequestFields.reasoning_config;
	assert.strictEqual(rc.type, "enabled");
	assert.ok(rc.budget_tokens < 8192, `budget ${rc.budget_tokens} must leave room for the answer`);
	assert.ok(rc.budget_tokens >= 1024, "must respect Anthropic's floor");

	const none = buildRequestInput({
		model: model("anthropic.claude-3-haiku-20240307-v1:0", 4096),
		converted: { messages: [userMsg("hi")], system: [] }, options: {},
		profile: getModelProfile("anthropic.claude-3-haiku-20240307-v1:0"),
		thinking: { enabled: true, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(none.thinkingEnabled, false, "old model must ignore thinking, not fail");
	assert.strictEqual(none.input.additionalModelRequestFields, undefined);
	return `adaptive=high; budget clamped to ${rc.budget_tokens}/8192; claude3 ignores it`;
});

await test("forced tool choice relaxed to auto when thinking is on", async () => {
	const b = buildRequestInput({
		model: model(ADAPTIVE, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(ADAPTIVE),
		toolConfig: { ...TOOLS, toolChoice: { tool: { name: "write_file" } } },
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.deepStrictEqual(b.input.toolConfig.toolChoice, { auto: {} });
	return "tool choice → auto";
});

await test("effort variants: picker rows decode back to a real, invocable model ID", async () => {
	const rows = expandEffortVariants({
		id: ADAPTIVE, name: "Claude Sonnet 4.6", detail: "Anthropic • Multi-Region",
		tooltip: "AWS Bedrock - Anthropic", family: "bedrock", version: "1.0.0",
		maxInputTokens: 200000, maxOutputTokens: 64000,
		capabilities: { toolCalling: true, imageInput: true },
	});
	assert.strictEqual(rows.length, 1 + THINKING_EFFORTS.length);
	assert.strictEqual(rows[0].id, ADAPTIVE, "the plain row keeps the bare ID");

	// The wire ID and the capability profile must both come out of the decode, or
	// Bedrock is handed a model ID it has never heard of.
	for (const row of rows.slice(1)) {
		const { baseId, effort } = decodeVariantId(row.id);
		assert.strictEqual(baseId, ADAPTIVE);
		assert.ok(THINKING_EFFORTS.includes(effort));
		assert.deepStrictEqual(getModelProfile(baseId), getModelProfile(ADAPTIVE));

		const built = buildRequestInput({
			model: model(baseId, 64000), converted: { messages: [userMsg("hi")], system: [] },
			options: {}, profile: getModelProfile(baseId),
			thinking: { enabled: true, effort, budgetTokens: 0 },
		});
		assert.strictEqual(built.input.modelId, ADAPTIVE, "no variant suffix may reach the wire");
		assert.deepStrictEqual(built.input.additionalModelRequestFields.output_config, { effort });
	}

	// A model with no reasoning mode must not be padded out with dead rows.
	const nova = expandEffortVariants({ id: "amazon.nova-pro-v1:0", name: "Nova Pro" });
	assert.strictEqual(nova.length, 1);

	return `${rows.length} rows for Sonnet 4.6, 1 for Nova Pro`;
});

await test("effort precedence: a picked variant beats the status bar default", async () => {
	// The variant wins even when the global default is off entirely.
	assert.deepStrictEqual(resolveThinkingForTurn("xhigh", { enabled: false, effort: "low" }),
		{ enabled: true, effort: "xhigh", source: "model-picker" });
	// A plain row inherits, off included.
	assert.deepStrictEqual(resolveThinkingForTurn(undefined, { enabled: false, effort: "high" }),
		{ enabled: false, effort: "high", source: "default" });
	assert.deepStrictEqual(resolveThinkingForTurn(undefined, { enabled: true, effort: "high" }),
		{ enabled: true, effort: "high", source: "default" });
	// A stale or hand-typed suffix must degrade, not fail the request.
	assert.deepStrictEqual(decodeVariantId(`${ADAPTIVE}#think=extreme`), { baseId: ADAPTIVE });
	return "variant > default; unknown suffix degrades to base";
});

await test("the off variant is the only way to suppress reasoning for one conversation", async () => {
	// Without this row the picker could only ever raise reasoning: every effort
	// variant returns enabled:true, and the plain row inherits the global default.
	const pickerId = encodeVariantId(ADAPTIVE, "off");
	assert.strictEqual(pickerId, `${ADAPTIVE}#think=off`);
	const { baseId, effort } = decodeVariantId(pickerId);
	assert.strictEqual(baseId, ADAPTIVE, "no suffix may reach the wire");

	assert.deepStrictEqual(resolveThinkingForTurn(effort, { enabled: true, effort: "high" }),
		{ enabled: false, effort: "high", source: "model-picker" });

	// Nothing reasoning-related may reach the request, and with no reasoning there
	// is nothing to reserve output tokens for.
	const built = buildRequestInput({
		model: model(baseId, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(baseId), maxOutputTokensOverride: 0,
		thinking: { enabled: false, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(built.thinkingEnabled, false);
	assert.strictEqual(built.input.additionalModelRequestFields, undefined);
	assert.strictEqual(built.input.inferenceConfig.maxTokens, 64000);

	// The row exists only to override a default that is on.
	const withDefault = expandEffortVariants(
		{ id: ADAPTIVE, name: "Claude Sonnet 4.6", maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: {} },
		{ thinkingEnabledByDefault: true }
	);
	assert.strictEqual(withDefault.length, 2 + THINKING_EFFORTS.length);
	assert.strictEqual(decodeVariantId(withDefault[1].id).effort, "off", "off must lead the variants");
	const withoutDefault = expandEffortVariants(
		{ id: ADAPTIVE, name: "Claude Sonnet 4.6", maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: {} },
		{ thinkingEnabledByDefault: false }
	);
	assert.ok(withoutDefault.every((v) => decodeVariantId(v.id).effort !== "off"));
	return `off suppresses a "high" default; ${withDefault.length} rows with it, ${withoutDefault.length} without`;
});

await test("effort variants LIVE: a variant-derived effort is accepted by Bedrock", async () => {
	// End-to-end proof that the ID the picker hands back produces a request
	// Bedrock will actually run — the failure mode being a variant suffix leaking
	// onto the wire as an unknown model ID.
	const pickerId = encodeVariantId(ADAPTIVE, "low");
	const { baseId, effort } = decodeVariantId(pickerId);
	const built = buildRequestInput({
		model: model(baseId, 4096),
		converted: { messages: [userMsg("What is 19 * 23? Answer with the number only.")], system: [] },
		options: {}, profile: getModelProfile(baseId),
		thinking: { enabled: true, effort, budgetTokens: 0 },
	});
	const { result, progress } = await run(built.input, { thinkingDisplay: "hidden" });
	assert.notStrictEqual(result.stopReason, undefined, "the request must complete, not fault");
	assert.ok(progress.text().includes("437"), `expected 437 in: ${progress.text()}`);
	return `effort=${effort} accepted; stop=${result.stopReason}, reasoning blocks=${result.reasoning.length}`;
});

await test(`native thinking display — ${INSIDERS ? "API present (Insiders)" : "API absent (stable)"}`, async () => {
	resetThinkingPartCache();
	if (INSIDERS) {
		assert.ok(getThinkingPartCtor(), "probe must find the API when it is present");
		const pi = makeProgress();
		const ri = createThinkingReporter(pi, "native");
		ri.delta("native reasoning"); ri.end();
		assert.ok(pi.parts.some((x) => x instanceof LanguageModelThinkingPart),
			"native must emit a real thinking part on Insiders");
		assert.ok(!pi.text().includes("<details>"), "must use the native UI, not the text fallback");
		return "probe found the API; emitted a LanguageModelThinkingPart";
	}
	// null (not undefined) is the deliberate "probed, absent" verdict; undefined
	// is the not-yet-probed sentinel that drives the cache.
	assert.strictEqual(getThinkingPartCtor(), null, "stable VS Code must report no thinking API");
	const p1 = makeProgress();
	const r1 = createThinkingReporter(p1, "native");
	r1.delta("secret reasoning"); r1.end();
	assert.strictEqual(p1.parts.length, 0, "native must emit nothing without the API");

	const p2 = makeProgress();
	const r2 = createThinkingReporter(p2, "text");
	r2.delta("visible reasoning"); r2.end();
	assert.ok(p2.text().includes("<details>"), "text mode must render a collapsed block");
	assert.ok(p2.text().includes("visible reasoning"));

	const p3 = makeProgress();
	const r3 = createThinkingReporter(p3, "hidden");
	r3.delta("nope"); r3.end();
	assert.strictEqual(p3.parts.length, 0, "hidden must emit nothing");
	return "native→silent, text→<details>, hidden→silent";
});

await test("usage tracker aggregates a session", async () => {
	const t = new UsageTracker();
	t.reset();
	t.record({ modelId: CHEAP, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheWriteInputTokens: 90 }, latencyMs: 500, stopReason: "end_turn", toolCalls: 0, cachePoints: 4, contextWindow: 200000 });
	t.record({ modelId: CHEAP, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadInputTokens: 90 }, latencyMs: 400, stopReason: "tool_use", toolCalls: 1, cachePoints: 4, contextWindow: 200000 });
	const tot = t.getTotals();
	assert.strictEqual(tot.turns, 2);
	assert.strictEqual(tot.inputTokens, 300);
	assert.strictEqual(tot.outputTokens, 30);
	assert.strictEqual(tot.cacheReadInputTokens, 90);
	assert.strictEqual(tot.cacheWriteInputTokens, 90);
	return `turns=2 in=300 out=30 read=90 write=90`;
});

/* ================================================================ LIVE TESTS */

console.log(`\n--- Live against Bedrock (${REGION}) ---\n`);

await test("#22 LIVE: usage, latency and stopReason captured from metadata", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("Reply with exactly the word: ok")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 64,
	});
	const { result, progress } = await run(built.input);
	assert.ok(result.usage, "no usage captured — metadata event was ignored");
	assert.ok(result.usage.inputTokens > 0, "inputTokens missing");
	assert.ok(result.usage.outputTokens > 0, "outputTokens missing");
	assert.ok(typeof result.latencyMs === "number" && result.latencyMs > 0, "latencyMs missing");
	assert.strictEqual(result.stopReason, "end_turn");
	assert.ok(progress.text().length > 0, "no text reported to VS Code");
	return `in=${result.usage.inputTokens} out=${result.usage.outputTokens} latency=${result.latencyMs}ms stop=${result.stopReason} text=${JSON.stringify(progress.text().trim().slice(0, 20))}`;
});

await test("#19 LIVE turn 1: cache checkpoints written", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("Say 'ready' and nothing else.")], system: [{ text: BIG_SYSTEM }] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
		maxOutputTokensOverride: 64, promptCaching: true,
	});
	// Turn 1 has only ONE user message, so only 3 checkpoints are possible:
	// tool schemas + system prompt + that single user message. The 4th appears
	// from turn 2 onward, once a previous user message exists to mark.
	assert.strictEqual(built.cachePoints, 3, "expected 3 checkpoints on a single-user-message turn");
	assert.ok(built.input.system.some((s) => s.cachePoint), "system prompt not checkpointed");
	const { result } = await run(built.input);
	const w = result.usage.cacheWriteInputTokens ?? 0;
	const r = result.usage.cacheReadInputTokens ?? 0;
	// Either outcome proves the checkpoints were honoured: a write on a cold cache,
	// or a read if a recent run already populated it (entries live ~5 minutes).
	assert.ok(w > 0 || r > 0,
		`Bedrock reported no cache activity at all (read=${r}, write=${w}) — checkpoints were refused`);
	return `cacheWrite=${w}, cacheRead=${r}, cachePoints=${built.cachePoints} (${w > 0 ? "cold cache" : "warm from a prior run"})`;
});

await test("#19 LIVE turn 2: previous checkpoint reads back as a hit", async () => {
	// Same prefix, one more turn appended — exactly what turn N+1 of a session sends.
	const grown = [
		{ role: "user", content: [{ text: "Say 'ready' and nothing else." }] },
		{ role: "assistant", content: [{ text: "ready" }] },
		{ role: "user", content: [{ text: "Now say 'again' and nothing else." }] },
	];
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: grown, system: [{ text: BIG_SYSTEM }] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
		maxOutputTokensOverride: 64, promptCaching: true,
	});
	// Now both trailing user messages are markable, so the full 4 appear.
	assert.strictEqual(built.cachePoints, 4, "expected 4 checkpoints once a previous user turn exists");
	const { result } = await run(built.input);
	const r = result.usage.cacheReadInputTokens ?? 0;
	const w = result.usage.cacheWriteInputTokens ?? 0;
	assert.ok(r > 0, `no cache read (read=${r}, write=${w}) — caching is not compounding across turns`);
	return `cacheRead=${r} tokens (billed at reduced rate), cacheWrite=${w}, cachePoints=4`;
});

await test("#25 LIVE: large tool call arrives as valid, parsed JSON", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 16384),
		converted: { messages: [userMsg(
			"Use the write_file tool to create 'src/generated/config.ts'. The content must be a " +
			"TypeScript module exporting at least 25 named const values with realistic comments — " +
			"make it genuinely long, several thousand characters. Call the tool once."
		)], system: [] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
	});
	// The whole point: no artificial 4096 cap on a big tool call.
	assert.strictEqual(built.input.inferenceConfig.maxTokens, 16384);
	const { result, progress } = await run(built.input);
	assert.deepStrictEqual(result.toolCallFailures, [], `tool call failures: ${JSON.stringify(result.toolCallFailures)}`);
	const calls = progress.toolCalls();
	assert.strictEqual(calls.length, 1, `expected exactly 1 tool call, got ${calls.length}`);
	assert.strictEqual(calls[0].name, "write_file");
	assert.strictEqual(typeof calls[0].input, "object", "input was not parsed into an object");
	assert.ok(typeof calls[0].input.content === "string" && calls[0].input.content.length > 500,
		`content too short to prove the point: ${calls[0].input.content?.length} chars`);
	assert.notStrictEqual(result.stopReason, "max_tokens", "response was truncated by the output cap");
	return `stop=${result.stopReason}, args=${JSON.stringify(calls[0].input).length} chars, content=${calls[0].input.content.length} chars, failures=0`;
});

await test("#25 LIVE: zero-parameter tool emits {} instead of failing", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 4096),
		converted: { messages: [userMsg("What time is it? Use the get_current_time tool.")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: NO_PARAM_TOOL,
	});
	const { result, progress } = await run(built.input);
	assert.deepStrictEqual(result.toolCallFailures, [], "a no-arg tool must not be recorded as a failure");
	const calls = progress.toolCalls();
	assert.strictEqual(calls.length, 1, `expected 1 tool call, got ${calls.length}`);
	assert.deepStrictEqual(calls[0].input, {}, `expected {}, got ${JSON.stringify(calls[0].input)}`);
	return `emitted ${calls[0].name} with {} , failures=0`;
});

await test("thinking LIVE (budget API, Claude 4.5): signed reasoning captured", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("A rope ladder hangs over a boat's side with 3 rungs above water, rungs 30cm apart. The tide rises 60cm. How many rungs are above water? Think it through.")], system: [] },
		options: {}, profile: getModelProfile(CHEAP),
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.ok(built.input.additionalModelRequestFields.reasoning_config, "no reasoning_config sent");
	const { result, progress } = await run(built.input, { thinkingDisplay: "text" });
	assert.ok(result.reasoning.length > 0, "no reasoning blocks captured");
	const withSig = result.reasoning.filter((r) => r.signature);
	assert.ok(withSig.length > 0, "reasoning has no signature — cannot be replayed next turn");
	assert.ok(result.reasoning[0].text.length > 0, "reasoning text empty");
	assert.ok(progress.text().includes("<details>"), "text display did not render the block");
	return `${result.reasoning.length} block(s), ${result.reasoning[0].text.length} chars, signature present (${withSig[0].signature.length} chars)`;
});

await test("thinking LIVE (adaptive API, Claude 4.6): reasoning captured", async () => {
	const built = buildRequestInput({
		model: model(ADAPTIVE, 64000),
		converted: { messages: [userMsg("Is 8191 prime? Reason briefly, then answer.")], system: [] },
		options: {}, profile: getModelProfile(ADAPTIVE), maxOutputTokensOverride: 4096,
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.deepStrictEqual(built.input.additionalModelRequestFields.thinking, { type: "adaptive" });
	const { result } = await run(built.input, { thinkingDisplay: "hidden" });
	assert.ok(result.reasoning.length > 0, "no reasoning captured from the adaptive API");
	assert.ok(result.usage.outputTokens > 0);
	return `${result.reasoning.length} block(s), ${result.reasoning[0].text.length} chars, stop=${result.stopReason}`;
});

await test("#22 LIVE: native CountTokens — exact count, or clean fallback if IAM denies it", async () => {
	// Establish what the account actually permits, so a missing IAM action is not
	// mistaken for a defect in the extension.
	const { CountTokensCommand } = require(path.join(EXT, "node_modules/@aws-sdk/client-bedrock-runtime"));
	let apiVerdict = "allowed";
	try {
		await new BedrockRuntimeClient({ region: REGION }).send(new CountTokensCommand({
			modelId: CHEAP, input: { converse: { messages: [userMsg("probe")] } } }));
	} catch (e) { apiVerdict = e.name; }

	const c = new BedrockClient(REGION);
	const n = await c.countTokens(undefined, CHEAP,
		{ messages: [userMsg(BIG_SYSTEM)], system: [{ text: "be precise" }], toolConfig: TOOLS });

	if (apiVerdict === "allowed") {
		assert.ok(typeof n === "number" && n > 0, `CountTokens returned ${n} despite being permitted`);
		const estimate = Math.ceil(BIG_SYSTEM.length / 4);
		return `exact=${n} tokens vs char-estimate=${estimate} (${((n / estimate - 1) * 100).toFixed(1)}% off)`;
	}
	// Not permitted: the contract is graceful degradation, not a thrown error.
	assert.strictEqual(n, undefined, "must return undefined so the caller estimates instead");
	return `IAM denies bedrock:CountTokens (${apiVerdict}) — extension fell back to estimation cleanly`;
});

await test("CountTokens on an unsupported model degrades and memoizes", async () => {
	const c = new BedrockClient(REGION);
	const n = await c.countTokens(undefined, "anthropic.definitely-not-a-model-v9",
		{ messages: [userMsg("hi")] });
	assert.strictEqual(n, undefined, "must return undefined, not throw, so the caller can estimate");
	const t0 = Date.now();
	const again = await c.countTokens(undefined, "anthropic.definitely-not-a-model-v9",
		{ messages: [userMsg("hi")] });
	const ms = Date.now() - t0;
	assert.strictEqual(again, undefined);
	assert.ok(ms < 50, `second call took ${ms}ms — not memoized, paying a round trip every turn`);
	return `fell back to estimation; 2nd call short-circuited in ${ms}ms`;
});

await test("mid-stream fault surfaces as an error instead of a silent stop", async () => {
	const faulty = { [Symbol.asyncIterator]: () => { let i = 0; return { next: async () => {
		i++;
		if (i === 1) { return { value: { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } }, done: false }; }
		if (i === 2) { return { value: { throttlingException: { message: "Too many requests" } }, done: false }; }
		return { value: undefined, done: true };
	} }; } };
	const progress = makeProgress();
	await assert.rejects(
		() => new StreamProcessor().processStream(faulty, progress, noCancel, {}),
		/ThrottlingException|Too many requests/,
		"a throttling event must not end the turn quietly");
	assert.strictEqual(progress.text(), "partial", "text before the fault should still have been reported");
	return "ThrottlingException raised, prior text preserved";
});

/* -------------------------------------------------------------------- report */

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
console.log(`\n================ ${pass}/${results.length} passed ================`);
if (fail.length) { console.log("FAILURES:"); fail.forEach((f) => console.log(`  - ${f.name}: ${f.note}`)); }
console.log(`\nBedrock calls: ${spend.calls} | input ${spend.in} tok | output ${spend.out} tok | cacheRead ${spend.cacheRead} | cacheWrite ${spend.cacheWrite}`);
process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
