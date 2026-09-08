import * as assert from "assert";
import * as vscode from "vscode";
import { BedrockChatProvider } from "../providers/bedrock-chat.provider";
import { ConfigurationService } from "../services/configuration.service";
import { AuthenticationService } from "../services/authentication.service";
import { convertMessages, detectImageFormat, reconcileToolBlocks, collectToolResultText } from "../converters/messages";
import { convertTools } from "../converters/tools";
import {
	validateRequest,
	validateTools,
	describeThinkingBudgetConflict,
	explainBedrockValidationError,
	checkTokenSettings,
} from "../validation";
import { tryParseJSONObject } from "../converters/schema";
import { ToolCallBufferManager } from "../tool-buffer";
import { getProxyAgent, isPermanentRejection } from "../clients/bedrock.client";
import { getModelProfile, parseClaudeVersion, anthropicThinkingApi } from "../profiles";
import type { ThinkingEffort } from "../converters/request";
import {
	buildRequestInput,
	budgetForEffort,
	resolveMaxTokens,
	minMaxTokensForEffort,
	MIN_THINKING_BUDGET,
	MIN_ANSWER_TOKENS,
	LAST_RESORT_MAX_OUTPUT_TOKENS,
} from "../converters/request";
import { applyCachePoints } from "../converters/cache-points";
import { StreamProcessor } from "../stream-processor";
import { createThinkingReporter, getThinkingPartCtor, resetThinkingPartCache } from "../thinking";
import { UsageTracker } from "../usage-tracker";
import { TokenEstimator } from "../providers/token.estimator";
import { describeToolCallFailure } from "../providers/chat-request.handler";
import {
	resolveInvocationTarget,
	regionGeoPrefix,
	manualModelToSummary,
	defaultMaxOutputTokens,
	expandEffortVariants,
	resolveOutputCeiling,
} from "../services/model.service";
import {
	assessEffort,
	assessAllEfforts,
	describeAvailability,
	detailForAvailability,
	iconForAvailability,
} from "../effort-availability";
import { formatConfigurationReport } from "../commands/show-configuration";
import {
	THINKING_EFFORTS,
	decodeVariantId,
	encodeVariantId,
	resolveThinkingForTurn,
	isThinkingEffort,
	OFF_VARIANT,
} from "../thinking-variants";
import type { BedrockMessage, BedrockSystemBlock, BedrockToolResultBlock } from "../types";

/** Shape of the provider-specific fields the request builder attaches. */
interface AdditionalFields {
	thinking?: { type?: string };
	output_config?: { effort?: string };
	reasoning_config?: { type?: string; budget_tokens?: number };
}

type ConfigurationProvider = typeof vscode.workspace.getConfiguration;

/**
 * Swap `vscode.workspace.getConfiguration` for a stub. The stubs return only the
 * handful of members under test rather than a whole WorkspaceConfiguration.
 */
function setConfigurationProvider(fn: unknown): void {
	(vscode.workspace as { getConfiguration: ConfigurationProvider }).getConfiguration =
		fn as ConfigurationProvider;
}

suite("Bedrock Chat Provider Extension", () => {
	suite("provider", () => {
		test("prepareLanguageModelChatInformation returns array (no key -> empty)", async () => {
			const configService = new ConfigurationService();
			const authService = new AuthenticationService(configService);
			const provider = new BedrockChatProvider(configService, authService);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
		});

		test("provideTokenCount counts simple string", async () => {
			const configService = new ConfigurationService();
			const authService = new AuthenticationService(configService);
			const provider = new BedrockChatProvider(configService, authService);

			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "bedrock",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				"hello world",
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideTokenCount counts message parts", async () => {
			const configService = new ConfigurationService();
			const authService = new AuthenticationService(configService);
			const provider = new BedrockChatProvider(configService, authService);

			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hello world")],
				name: undefined,
			};
			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "bedrock",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				msg,
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideLanguageModelChatResponse throws without API key", async () => {
			const configService = new ConfigurationService();
			const authService = new AuthenticationService(configService);
			const provider = new BedrockChatProvider(configService, authService);

			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "m",
						name: "m",
						family: "bedrock",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				threw = true;
			}
			assert.ok(threw);
		});
	});

	suite("converters/messages", () => {
		test("maps user/assistant text", () => {
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("hi")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelTextPart("hello")],
					name: undefined,
				},
			];
			const result = convertMessages(messages, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
			assert.equal(result.messages.length, 2);
			assert.equal(result.messages[0].role, "user");
			assert.equal(result.messages[1].role, "assistant");
		});

		test("maps tool calls and results", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("abc", "toolA", { foo: 1 });
			const toolResult = new vscode.LanguageModelToolResultPart("abc", [new vscode.LanguageModelTextPart("result")]);
			const messages: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [toolResult], name: undefined },
			];
			const result = convertMessages(messages, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
			assert.ok(result.messages.length > 0);
			const hasToolUse = result.messages.some((m) => m.content.some((c) => "toolUse" in c));
			const hasToolResult = result.messages.some((m) => m.content.some((c) => "toolResult" in c));
			assert.ok(hasToolUse || hasToolResult);
		});

		test("handles mixed text + tool calls in one assistant message", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("before "), toolCall, new vscode.LanguageModelTextPart(" after")],
				name: undefined,
			};
			const result = convertMessages([msg], 'anthropic.claude-3-5-sonnet-20241022-v2:0');
			assert.equal(result.messages[0].role, "assistant");
			assert.ok(result.messages[0].content.length > 0);
			// The tool call has no result, so reconciliation appends a synthetic one.
			// Bedrock rejects a request that ends on an unanswered tool_use, and a 400
			// with no detail is far worse than telling the model its tool did not run.
			assert.equal(result.messages.length, 2);
			assert.equal(result.messages[1].role, "user");
			assert.ok(result.messages[1].content.some((c) => "toolResult" in c));
		});

		test("uses magic-byte format when mimeType is wrong (PNG reported as jpeg)", () => {
			const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
			const msg = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [{ mimeType: "image/jpeg", data: png }],
				name: undefined,
			} as unknown as vscode.LanguageModelChatMessage;
			const result = convertMessages([msg], 'anthropic.claude-3-5-sonnet-20241022-v2:0');
			const imageBlock = result.messages[0].content.find(c => "image" in c);
			assert.ok(imageBlock && "image" in imageBlock, "expected an image content block");
			assert.equal((imageBlock as { image: { format: string } }).image.format, "png");
		});
	});

	suite("converters/detectImageFormat", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
		const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
		const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

		test("PNG bytes override a wrong jpeg mimeType", () => {
			assert.equal(detectImageFormat(png, "image/jpeg"), "png");
		});

		test("detects JPEG, GIF and WebP from magic bytes", () => {
			assert.equal(detectImageFormat(jpeg, "image/png"), "jpeg");
			assert.equal(detectImageFormat(gif, "application/octet-stream"), "gif");
			assert.equal(detectImageFormat(webp, "image/png"), "webp");
		});

		test("falls back to mimeType when bytes are unrecognizable", () => {
			const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
			assert.equal(detectImageFormat(junk, "image/png"), "png");
		});

		test("normalizes jpg to jpeg on the mimeType fallback path", () => {
			const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
			assert.equal(detectImageFormat(junk, "image/jpg"), "jpeg");
		});

		test("falls back to mimeType for undefined or short buffers", () => {
			assert.equal(detectImageFormat(undefined, "image/gif"), "gif");
			assert.equal(detectImageFormat(png.slice(0, 4), "image/webp"), "webp");
		});

		test("returns null when nothing is determinable", () => {
			assert.equal(detectImageFormat(undefined, ""), null);
		});
	});

	suite("converters/tools", () => {
		test("convertTools returns Bedrock tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
			} satisfies vscode.LanguageModelChatRequestHandleOptions, 'anthropic.claude-3-5-sonnet-20241022-v2:0');

			assert.ok(out);
			assert.ok(out.toolChoice);
			assert.ok(Array.isArray(out.tools));
			const first = out.tools[0];
			assert.ok("toolSpec" in first);
			assert.equal(first.toolSpec.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.LanguageModelChatRequestHandleOptions, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
			assert.ok(out);
			assert.ok(out.toolChoice?.tool);
			assert.equal(out.toolChoice?.tool?.name, "only_tool");
		});

		test("validateTools rejects invalid names", () => {
			const badTools: vscode.LanguageModelChatTool[] = [{ name: "bad name!", description: "", inputSchema: {} }];
			assert.throws(() => validateTools(badTools));
		});
	});

	suite("validation", () => {
		test("validateRequest enforces tool result pairing", () => {
			const callId = "xyz";
			const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
			const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
			const valid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
			];
			assert.doesNotThrow(() => validateRequest(valid));

			const invalid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("missing")], name: undefined },
			];
			assert.throws(() => validateRequest(invalid));
		});
	});

	suite("profiles", () => {
		test("Claude 4+ and unrecognized Anthropic IDs omit temperature (fail closed)", () => {
			// Bedrock rejects the temperature inference parameter for Claude 4+ models.
			const claude4PlusIds = [
				"anthropic.claude-sonnet-4-5-20250929-v1:0",
				"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"anthropic.claude-opus-4-7-20250805-v1:0",
				"anthropic.claude-opus-4-20250514-v1:0",
				"anthropic.claude-haiku-4-5-20251001-v1:0",
				"anthropic.claude-sonnet-5",
				"us.anthropic.claude-sonnet-5-20260101-v1:0",
				"anthropic.claude-opus-5-20260101-v1:0",
				"anthropic.claude-sonnet-10-20270101-v1:0",
				"anthropic.claude-nova-7-20280101-v1:0",
				"anthropic.claude-5-sonnet-20270101-v1:0",
			];
			for (const id of claude4PlusIds) {
				assert.equal(getModelProfile(id).supportsTemperature, false, `expected supportsTemperature=false for ${id}`);
			}
		});

		test("Claude 3.x and non-Claude models keep temperature (supportsTemperature === true)", () => {
			const keepTemperatureIds = [
				"anthropic.claude-3-5-sonnet-20241022-v2:0",
				"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
				"anthropic.claude-3-haiku-20240307-v1:0",
				"us.anthropic.claude-3-haiku-20240307-v1:0",
				"anthropic.claude-instant-v1",
				"anthropic.claude-v2:1",
				"mistral.mistral-large-2407-v1:0",
				"amazon.nova-pro-v1:0",
			];
			for (const id of keepTemperatureIds) {
				assert.equal(getModelProfile(id).supportsTemperature, true, `expected supportsTemperature=true for ${id}`);
			}
		});

		test("unknown providers default to supportsTemperature === true", () => {
			assert.equal(getModelProfile("cohere.command-r-v1:0").supportsTemperature, true);
			assert.equal(getModelProfile("meta.llama3-70b-instruct-v1:0").supportsTemperature, true);
		});

		test("provider-routing matrix: full profile per provider, incl. regional prefixes", () => {
			// This is the routing table every model flows through. Each row asserts the
			// complete profile so a change to one provider can't silently shift another.
			const none = { thinkingApi: 'none' as const, supportsPromptCaching: false, maxCachePoints: 0 };
			const cacheable = { supportsPromptCaching: true, maxCachePoints: 4 };
			const matrix: [string, ReturnType<typeof getModelProfile>][] = [
				// anthropic: tool choice + text results; temperature only for pre-4.x
				["anthropic.claude-3-5-sonnet-20241022-v2:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, thinkingApi: 'none', ...cacheable }],
				["us.anthropic.claude-3-5-sonnet-20241022-v2:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, thinkingApi: 'none', ...cacheable }],
				["anthropic.claude-3-7-sonnet-20250219-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, thinkingApi: 'budget', ...cacheable }],
				["anthropic.claude-sonnet-4-5-20250929-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false, thinkingApi: 'budget', ...cacheable }],
				["eu.anthropic.claude-sonnet-4-5-20250929-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false, thinkingApi: 'budget', ...cacheable }],
				["anthropic.claude-sonnet-4-6", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false, thinkingApi: 'adaptive', ...cacheable }],
				["anthropic.claude-sonnet-5", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false, thinkingApi: 'adaptive', ...cacheable }],
				["anthropic.claude-3-haiku-20240307-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, ...none }],
				// mistral: NO tool choice + JSON tool-result format
				["mistral.mistral-large-2407-v1:0", { supportsToolChoice: false, toolResultFormat: 'json', supportsTemperature: true, ...none }],
				["us.mistral.pixtral-large-2502-v1:0", { supportsToolChoice: false, toolResultFormat: 'json', supportsTemperature: true, ...none }],
				// amazon nova: tool choice + text + caching; non-nova amazon falls back to default
				["amazon.nova-pro-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, thinkingApi: 'none', ...cacheable }],
				["us.amazon.nova-lite-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, thinkingApi: 'none', ...cacheable }],
				["amazon.nova-micro-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true, ...none }],
				["amazon.titan-text-express-v1", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true, ...none }],
				// cohere / meta / ai21: default profile
				["cohere.command-r-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true, ...none }],
				["meta.llama3-70b-instruct-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true, ...none }],
				["ai21.jamba-1-5-large-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true, ...none }],
			];
			for (const [id, expected] of matrix) {
				assert.deepEqual(getModelProfile(id), expected, `profile mismatch for ${id}`);
			}
		});

		test("cross-region routing prefixes are stripped, not treated as a provider", () => {
			// A "global."-prefixed ID used to fall through to the default profile,
			// which reports supportsTemperature=true and would send temperature to a
			// Claude 4 model. Bedrock rejects that on every request.
			for (const id of [
				"global.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"apac.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
			]) {
				const profile = getModelProfile(id);
				assert.equal(profile.supportsTemperature, false, `expected temperature omitted for ${id}`);
				assert.equal(profile.supportsToolChoice, true, `expected anthropic profile for ${id}`);
			}
		});

		test("parseClaudeVersion reads both Claude naming generations", () => {
			assert.deepEqual(parseClaudeVersion("anthropic.claude-3-5-sonnet-20241022-v2:0"), { major: 3, minor: 5 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-3-7-sonnet-20250219-v1:0"), { major: 3, minor: 7 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-3-haiku-20240307-v1:0"), { major: 3, minor: 0 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-sonnet-4-20250514-v1:0"), { major: 4, minor: 20250514 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-sonnet-4-5-20250929-v1:0"), { major: 4, minor: 5 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-opus-4-8"), { major: 4, minor: 8 });
			assert.deepEqual(parseClaudeVersion("anthropic.claude-sonnet-5"), { major: 5, minor: 0 });
			assert.equal(parseClaudeVersion("mistral.mistral-large-2407-v1:0"), undefined);
		});

		test("thinking API selection covers current and future Claude releases", () => {
			// 3.7 through 4.5 use the token-budget API; 4.6 and later choose their own
			// budget from an effort level. An unrecognized Claude ID is assumed current
			// rather than denied thinking, which is how Claude 5 was missed before.
			assert.equal(anthropicThinkingApi("anthropic.claude-3-5-sonnet-20241022-v2:0"), "none");
			assert.equal(anthropicThinkingApi("anthropic.claude-3-haiku-20240307-v1:0"), "none");
			assert.equal(anthropicThinkingApi("anthropic.claude-3-7-sonnet-20250219-v1:0"), "budget");
			assert.equal(anthropicThinkingApi("anthropic.claude-sonnet-4-5-20250929-v1:0"), "budget");
			assert.equal(anthropicThinkingApi("anthropic.claude-sonnet-4-6"), "adaptive");
			assert.equal(anthropicThinkingApi("anthropic.claude-opus-4-8"), "adaptive");
			assert.equal(anthropicThinkingApi("anthropic.claude-sonnet-5"), "adaptive");
			assert.equal(anthropicThinkingApi("anthropic.claude-sonnet-10-20270101-v1:0"), "adaptive");
			assert.equal(anthropicThinkingApi("anthropic.claude-future-model"), "adaptive");
		});

		test("the pre-3 naming schemes get no thinking API", () => {
			// These carry no parseable version, so "assume current" would otherwise
			// send a reasoning config to a model that predates the feature.
			assert.equal(anthropicThinkingApi("anthropic.claude-v2"), "none");
			assert.equal(anthropicThinkingApi("anthropic.claude-v2:1"), "none");
			assert.equal(anthropicThinkingApi("anthropic.claude-instant-v1"), "none");
			assert.equal(getModelProfile("anthropic.claude-v2").thinkingApi, "none");
		});
	});

	suite("converters/schema", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});

	suite("ToolCallBufferManager", () => {
		test("early emission - emits as soon as JSON becomes valid", async () => {
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = {
				report: (part: vscode.LanguageModelResponsePart) => emitted.push(part),
			};

			buffer.startToolCall(0, "call_123", "test_tool");

			buffer.appendArgs(0, '{"query":"');
			await buffer.tryEmit(0, progress);
			assert.equal(emitted.length, 0);

			buffer.appendArgs(0, 'test"}');
			await buffer.tryEmit(0, progress);
			assert.equal(emitted.length, 1);
			assert.ok(emitted[0] instanceof vscode.LanguageModelToolCallPart);
			const toolCall = emitted[0] as vscode.LanguageModelToolCallPart;
			assert.equal(toolCall.name, "test_tool");
			assert.deepEqual(toolCall.input, { query: "test" });
		});

		test("deduplicates on toolUseId, so identical parallel calls both survive", async () => {
			// Dedup used to key on the arguments, which silently dropped a model's
			// second request to read the same file in one turn. Bedrock guarantees
			// toolUseId is unique per call, so that is the correct key.
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "search");
			buffer.appendArgs(0, '{"query":"test"}');
			await buffer.tryEmit(0, progress);

			buffer.startToolCall(1, "call_2", "search");
			buffer.appendArgs(1, '{"query":"test"}');
			await buffer.tryEmit(1, progress);

			assert.equal(emitted.length, 2, "identical arguments with distinct IDs are two real calls");
			assert.deepEqual(buffer.getEmittedIds(), ["call_1", "call_2"]);
		});

		test("a repeated toolUseId is emitted only once", async () => {
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "search");
			buffer.appendArgs(0, '{"query":"a"}');
			await buffer.tryEmit(0, progress);

			buffer.startToolCall(1, "call_1", "search");
			buffer.appendArgs(1, '{"query":"b"}');
			await buffer.tryEmit(1, progress);

			assert.equal(emitted.length, 1);
			assert.deepEqual(buffer.getEmittedIds(), ["call_1"]);
		});

		test("a zero-parameter tool emits {} once its block closes", async () => {
			// A tool with no parameters produces no input deltas at all. Treating the
			// empty buffer as a parse failure made every such call vanish.
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "list_files");
			await buffer.tryEmit(0, progress);
			assert.equal(emitted.length, 0, "must not fire before the block closes");

			await buffer.tryEmit(0, progress, true);
			assert.equal(emitted.length, 1);
			assert.deepEqual((emitted[0] as vscode.LanguageModelToolCallPart).input, {});
			assert.equal(buffer.getFailures().length, 0);
		});

		test("truncated arguments fail once, are never repaired, and carry a snippet", async () => {
			// The original bug logged this error twice because contentBlockStop forces
			// an emit and messageStop then forces another over the same buffer.
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "replace_string_in_file");
			buffer.appendArgs(0, '{"filePath":"/a/b.py","newString":"def f():\\n    ret');

			await buffer.tryEmit(0, progress, true);
			await buffer.tryEmit(0, progress, true);
			await buffer.emitAll(progress);

			assert.equal(emitted.length, 0, "a half-written edit must never be applied");
			const failures = buffer.getFailures();
			assert.equal(failures.length, 1, "the same failure must not be reported twice");
			assert.equal(failures[0].name, "replace_string_in_file");
			assert.equal(failures[0].toolUseId, "call_1");
			assert.ok(failures[0].snippet.startsWith('{"filePath"'), "snippet must show the partial arguments");
			assert.ok(failures[0].argsLength > 0, "argsLength distinguishes truncation from an empty buffer");
		});

		test("object-valued input deltas are stringified, not coerced to [object Object]", async () => {
			// Bedrock documents delta.toolUse.input as a string, but some model
			// families return an already-parsed object.
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "search");
			buffer.appendArgs(0, { query: "test" } as unknown as string);
			await buffer.tryEmit(0, progress, true);

			assert.equal(emitted.length, 1);
			assert.deepEqual((emitted[0] as vscode.LanguageModelToolCallPart).input, { query: "test" });
		});

		test("deltas that arrive before contentBlockStart are kept, not dropped", async () => {
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.appendArgs(0, '{"query":');
			await buffer.tryEmit(0, progress);
			assert.equal(emitted.length, 0, "no name yet, so nothing is callable");
			assert.equal(buffer.getFailures().length, 0, "must not give up before the block closes");

			buffer.startToolCall(0, "call_1", "search");
			buffer.appendArgs(0, '"test"}');
			await buffer.tryEmit(0, progress);

			assert.equal(emitted.length, 1);
			assert.deepEqual((emitted[0] as vscode.LanguageModelToolCallPart).input, { query: "test" });
		});

		test("a nameless tool call is reported as a failure once its block closes", async () => {
			const buffer = new ToolCallBufferManager();
			const buffer2 = new ToolCallBufferManager();
			const progress = { report: () => {} };

			buffer.appendArgs(0, '{"query":"test"}');
			await buffer.tryEmit(0, progress);
			assert.equal(buffer.getFailures().length, 0);
			await buffer.tryEmit(0, progress, true);
			assert.equal(buffer.getFailures().length, 1);

			// Nothing at all for an index is not a failure, it is just an absent block.
			await buffer2.tryEmit(7, progress, true);
			assert.equal(buffer2.getFailures().length, 0);
		});

		test("emitAll flushes every open block and counts what it emitted", async () => {
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => emitted.push(p) };

			buffer.startToolCall(0, "call_1", "a");
			buffer.appendArgs(0, '{"x":1}');
			buffer.startToolCall(1, "call_2", "b");
			buffer.appendArgs(1, '{"y":2}');
			buffer.startToolCall(2, "call_3", "c");
			buffer.appendArgs(2, '{"z":');

			await buffer.emitAll(progress);

			assert.equal(emitted.length, 2);
			assert.equal(buffer.getEmittedIds().length, 2);
			assert.equal(buffer.getFailures().length, 1);
			assert.equal(buffer.getFailures()[0].name, "c");
		});

		test("a space is inserted between streamed text and the first tool call only", () => {
			const buffer = new ToolCallBufferManager();
			assert.equal(buffer.shouldAddSpaceBeforeFirstTool(), false, "no text yet");
			buffer.markHasText();
			assert.equal(buffer.shouldAddSpaceBeforeFirstTool(), true);
			buffer.markFirstToolEmitted();
			assert.equal(buffer.shouldAddSpaceBeforeFirstTool(), false);
		});
	});

	suite("proxy", () => {
		const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
		let saved: Record<string, string | undefined>;

		setup(() => {
			saved = {};
			for (const v of PROXY_VARS) {
				saved[v] = process.env[v];
				delete process.env[v];
			}
		});

		teardown(() => {
			for (const v of PROXY_VARS) {
				if (saved[v] === undefined) {
					delete process.env[v];
				} else {
					process.env[v] = saved[v];
				}
			}
		});

		test("getProxyAgent returns undefined when no proxy env var is set", () => {
			assert.equal(getProxyAgent(), undefined);
		});

		test("getProxyAgent returns an agent when HTTPS_PROXY is set", () => {
			process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
			const agent = getProxyAgent();
			assert.ok(agent, "expected a proxy agent");
			assert.equal((agent as unknown as { proxy: URL }).proxy.href, "http://proxy.example.com:8080/");
		});

		test("getProxyAgent honors lowercase http_proxy", () => {
			process.env.http_proxy = "http://other.example.com:3128";
			assert.ok(getProxyAgent(), "expected a proxy agent from http_proxy");
		});
	});

	suite("bedrock client error classification", () => {
		const named = (name: string) => Object.assign(new Error("boom"), { name });

		test("permanent rejections disable a capability for the session", () => {
			// These mean the model or account will never answer the call.
			for (const name of [
				"ValidationException",
				"ResourceNotFoundException",
				"AccessDeniedException",
				"UnrecognizedClientException",
			]) {
				assert.equal(isPermanentRejection(named(name)), true, `${name} should be permanent`);
			}
		});

		test("transient faults must not disable it", () => {
			// Throttling or a network blip would otherwise downgrade token counting to
			// the heuristic for the rest of the session after one bad moment.
			for (const name of ["ThrottlingException", "ServiceUnavailableException", "TimeoutError", "Error"]) {
				assert.equal(isPermanentRejection(named(name)), false, `${name} should be transient`);
			}
			assert.equal(isPermanentRejection("not an error"), false);
			assert.equal(isPermanentRejection(undefined), false);
		});
	});

	suite("converters/request", () => {
		const baseConverted: { messages: BedrockMessage[]; system: BedrockSystemBlock[] } = {
			messages: [{ role: "user", content: [{ text: "hi" }] }],
			system: [],
		};
		const model = { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", maxOutputTokens: 4096 };

		test("omits temperature for Claude 4.x and 5, includes it for 3.x", () => {
			const claude4 = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 4096 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
			}).input;
			assert.equal(claude4.inferenceConfig!.temperature, undefined, "Claude 4.x must omit temperature");

			const sonnet5 = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-5", maxOutputTokens: 4096 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-5"),
				toolConfig: undefined,
			}).input;
			assert.equal(sonnet5.inferenceConfig!.temperature, undefined, "Claude Sonnet 5 must omit temperature");

			const claude35 = buildRequestInput({
				model,
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id),
				toolConfig: undefined,
			}).input;
			assert.equal(claude35.inferenceConfig!.temperature, 0.7, "Claude 3.x defaults temperature to 0.7");
		});

		test("assembles topP and stopSequences (string and array) from modelOptions", () => {
			const withTopP = buildRequestInput({
				model, converted: baseConverted,
				options: { modelOptions: { top_p: 0.9, stop: "STOP" } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			}).input;
			assert.equal(withTopP.inferenceConfig!.topP, 0.9);
			assert.deepEqual(withTopP.inferenceConfig!.stopSequences, ["STOP"]);

			const withStopArray = buildRequestInput({
				model, converted: baseConverted,
				options: { modelOptions: { stop: ["A", "B"] } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			}).input;
			assert.deepEqual(withStopArray.inferenceConfig!.stopSequences, ["A", "B"]);
			assert.equal(withStopArray.inferenceConfig!.topP, undefined, "no topP when not provided");
		});

		test("includes system + toolConfig only when present", () => {
			const withSystem = buildRequestInput({
				model, converted: { messages: baseConverted.messages, system: [{ text: "be terse" }] },
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: { tools: [] },
			}).input;
			assert.ok(withSystem.system, "system set when system blocks exist");
			assert.ok(withSystem.toolConfig, "toolConfig set when provided");

			const noExtras = buildRequestInput({
				model, converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			}).input;
			assert.equal(noExtras.system, undefined);
			assert.equal(noExtras.toolConfig, undefined);
		});

		test("defaults maxTokens to the model ceiling instead of 4096", () => {
			// Regression guard for the truncated-tool-call bug: Copilot never sends
			// max_tokens, so the old `|| 4096` fallback capped every response at 4096
			// output tokens and cut large tool calls off mid-JSON.
			const big = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
			}).input;
			assert.equal(big.inferenceConfig!.maxTokens, 64000);
		});

		test("honors a user maxOutputTokens override but never exceeds the model ceiling", () => {
			const capped = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 8192 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
				maxOutputTokensOverride: 64000,
			}).input;
			assert.equal(capped.inferenceConfig!.maxTokens, 8192);

			const lowered = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
				maxOutputTokensOverride: 2000,
			}).input;
			assert.equal(lowered.inferenceConfig!.maxTokens, 2000);
		});

		test("explicit modelOptions.max_tokens still wins over the override", () => {
			const built = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: { modelOptions: { max_tokens: 1234 } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
				maxOutputTokensOverride: 9999,
			}).input;
			assert.equal(built.inferenceConfig!.maxTokens, 1234);
		});

		test("a maxOutputTokens setting of 0 means the model ceiling, never 1", () => {
			// The shipped default for the setting is 0, documented as "use the model
			// maximum". The builder selected it with `?? modelCeiling`, which only
			// falls through on null/undefined, so a literal 0 won the chain and every
			// request Copilot did not attach its own max_tokens to went out with
			// maxTokens: 1. The 0 case was the one value never covered by a test.
			for (const sentinel of [0, undefined, -1, Number.NaN] as (number | undefined)[]) {
				const built = buildRequestInput({
					model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 64000 },
					converted: baseConverted,
					options: {} as vscode.LanguageModelChatRequestHandleOptions,
					profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
					toolConfig: undefined,
					maxOutputTokensOverride: sentinel,
				});
				assert.equal(
					built.input.inferenceConfig!.maxTokens,
					64000,
					`sentinel ${String(sentinel)} must fall through to the model ceiling`
				);
				assert.equal(built.maxTokens.source, "model-ceiling");
			}
		});

		test("the default configuration plus thinking produces a valid pair", () => {
			// The exact reported failure: maxOutputTokens unset (0), thinking on at
			// effort high. Bedrock rejected it with "max_tokens must be greater than
			// thinking.budget_tokens" because maxTokens had resolved to 1.
			for (const id of ["anthropic.claude-opus-5", "anthropic.claude-3-7-sonnet-20250219-v1:0"]) {
				const built = buildRequestInput({
					model: { id, maxOutputTokens: 64000 },
					converted: baseConverted,
					options: {} as vscode.LanguageModelChatRequestHandleOptions,
					profile: getModelProfile(id),
					toolConfig: undefined,
					maxOutputTokensOverride: 0,
					thinking: { enabled: true, effort: "high", budgetTokens: 0 },
				});
				assert.equal(built.thinkingEnabled, true, `${id} should have thinking on`);
				const maxTokens = built.input.inferenceConfig!.maxTokens!;
				assert.ok(
					maxTokens >= minMaxTokensForEffort("high"),
					`${id}: maxTokens ${maxTokens} must leave room for a high-effort budget`
				);
				assert.equal(built.maxTokens.conflict, undefined, `${id} must not report a conflict`);
			}
		});

		test("the budget is fitted under maxTokens instead of being clamped below Anthropic's floor", () => {
			// The original bug: the budget was clamped to `maxTokens - 1`, which cannot
			// go below the 1024-token floor, so a small limit produced an invalid pair
			// rather than a smaller budget. A ceiling that cannot seat the full xhigh
			// budget must still yield a valid budget/answer split.
			const built = buildRequestInput({
				model: { id: "anthropic.claude-3-7-sonnet-20250219-v1:0", maxOutputTokens: 8192 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-3-7-sonnet-20250219-v1:0"),
				toolConfig: undefined,
				thinking: { enabled: true, effort: "xhigh", budgetTokens: 0 },
			});
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			const budget = fields.reasoning_config!.budget_tokens!;
			const maxTokens = built.input.inferenceConfig!.maxTokens!;

			assert.equal(maxTokens, 8192, "an unset setting uses the model ceiling in full");
			assert.ok(budget >= MIN_THINKING_BUDGET, `budget ${budget} must clear Anthropic's floor`);
			assert.ok(
				maxTokens - budget >= MIN_ANSWER_TOKENS,
				`maxTokens ${maxTokens} must leave >= ${MIN_ANSWER_TOKENS} for the answer, budget was ${budget}`
			);
			assert.ok(
				budget < budgetForEffort("xhigh"),
				"the xhigh budget does not fit an 8192 ceiling, so it must have been reduced"
			);
			assert.equal(built.thinkingEnabled, true, "thinking must survive, not be dropped");
		});

		test("adaptive models also get maxTokens floored for their self-chosen budget", () => {
			// No budget is sent on the adaptive API, but the service still derives one
			// from the effort level — which is why an adaptive-only model could return
			// a thinking.budget_tokens error despite never receiving that field.
			const built = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-6", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-6"),
				toolConfig: undefined,
				maxOutputTokensOverride: 0,
				thinking: { enabled: true, effort: "xhigh", budgetTokens: 0 },
			});
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			assert.deepEqual(fields.thinking, { type: "adaptive" });
			assert.equal(fields.reasoning_config, undefined, "adaptive models must not get a budget");
			assert.ok(
				built.input.inferenceConfig!.maxTokens! >= minMaxTokensForEffort("xhigh"),
				"adaptive requests still need headroom for the model's own budget"
			);
		});

		test("an explicit cap too small for the effort is reported, not silently overridden", () => {			const built = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-6", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-6"),
				toolConfig: undefined,
				maxOutputTokensOverride: 500,
				thinking: { enabled: true, effort: "high", budgetTokens: 0 },
			});
			assert.equal(built.input.inferenceConfig!.maxTokens, 500, "an explicit cap is still honoured");
			assert.equal(built.thinkingEnabled, false, "thinking must be dropped rather than sent invalid");
			assert.ok(built.maxTokens.conflict, "the impossible combination must be reported");
			assert.equal(built.maxTokens.conflict!.source, "setting");
			assert.equal(built.input.additionalModelRequestFields, undefined);
		});

		test("adaptive models lower the effort when a caller-supplied max_tokens cannot fit it", () => {
			// The reported production failure, second form. Copilot supplies its own
			// small `max_tokens` for utility calls (titles, summaries). On the adaptive
			// API the request carries only `output_config.effort` and the service
			// derives the budget from it, so there is no budget to shrink — sending
			// "high" anyway produced:
			//   `max_tokens` must be greater than `thinking.budget_tokens`
			// The only lever is the effort itself.
			const built = buildRequestInput({
				model: { id: "anthropic.claude-opus-5", maxOutputTokens: 128000 },
				converted: baseConverted,
				options: { modelOptions: { max_tokens: 8192 } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-opus-5"),
				toolConfig: undefined,
				maxOutputTokensOverride: 0,
				thinking: { enabled: true, effort: "high", budgetTokens: 0 },
			});

			assert.equal(built.thinkingEnabled, true, "thinking should survive, just at a lower level");
			assert.equal(built.input.inferenceConfig!.maxTokens, 8192, "the caller's cap is honoured");
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			const sent = fields.output_config!.effort as ThinkingEffort;
			assert.equal(sent, "low", `8192 tokens only fits "low", got "${sent}"`);
			assert.equal(built.maxTokens.effortDowngradedFrom, "high", "the reduction must be reported");
			assert.ok(
				built.input.inferenceConfig!.maxTokens! >= minMaxTokensForEffort(sent),
				"the level actually sent must fit the limit"
			);
		});

		test("a fitting effort is never raised above what was requested", () => {
			// Fitting is not optimizing: silently spending more on reasoning than the
			// user asked for would be a surprise, and a costly one.
			const built = buildRequestInput({
				model: { id: "anthropic.claude-opus-5", maxOutputTokens: 128000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-opus-5"),
				toolConfig: undefined,
				maxOutputTokensOverride: 0,
				thinking: { enabled: true, effort: "low", budgetTokens: 0 },
			});
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			assert.equal(fields.output_config!.effort, "low", "plenty of room must not promote the level");
			assert.equal(built.maxTokens.effortDowngradedFrom, undefined);
		});

		test("adaptive thinking is dropped when even the lowest effort cannot fit", () => {
			const built = buildRequestInput({
				model: { id: "anthropic.claude-opus-5", maxOutputTokens: 128000 },
				converted: baseConverted,
				options: { modelOptions: { max_tokens: 3000 } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-opus-5"),
				toolConfig: undefined,
				maxOutputTokensOverride: 0,
				thinking: { enabled: true, effort: "high", budgetTokens: 0 },
			});
			assert.equal(built.thinkingEnabled, false, "better to drop thinking than send an invalid pair");
			assert.equal(built.input.additionalModelRequestFields, undefined);
			assert.equal(built.input.inferenceConfig!.maxTokens, 3000, "the caller's cap is still honoured");
		});

		test("invariant: every effort x thinking API x maxOutputTokens combination is valid", () => {
			// Property-style sweep over the whole family, because every bug in this
			// area has been a single point in this space that no example test covered.
			//
			// `request` is included as a dimension after the second production
			// failure: the sweep originally varied only the *setting*, so a
			// caller-supplied `max_tokens` — which is what Copilot sends for utility
			// calls — was never exercised, and that is exactly where the adaptive API
			// broke.
			const models = [
				{ id: "anthropic.claude-sonnet-4-6", api: "adaptive" },
				{ id: "anthropic.claude-opus-5", api: "adaptive" },
				{ id: "anthropic.claude-3-7-sonnet-20250219-v1:0", api: "budget" },
			] as const;
			const settings = [0, 1, 500, 1024, 4096, 32000, 999999, undefined];
			const requests = [undefined, 1, 500, 3000, 6144, 8192, 12288, 20480, 999999];

			for (const m of models) {
				assert.equal(getModelProfile(m.id).thinkingApi, m.api, `${m.id} profile changed`);
				for (const effort of THINKING_EFFORTS) {
					for (const setting of settings) {
						for (const request of requests) {
						for (const ceiling of [8192, 32000, 128000]) {
							const built = buildRequestInput({
								model: { id: m.id, maxOutputTokens: ceiling },
								converted: baseConverted,
								options: (request === undefined
									? {}
									: { modelOptions: { max_tokens: request } }) as unknown as vscode.LanguageModelChatRequestHandleOptions,
								profile: getModelProfile(m.id),
								toolConfig: undefined,
								maxOutputTokensOverride: setting,
								thinking: { enabled: true, effort, budgetTokens: 0 },
							});
							const where = `${m.id} effort=${effort} setting=${String(setting)} request=${String(request)} ceiling=${ceiling}`;
							const maxTokens = built.input.inferenceConfig!.maxTokens!;

							assert.ok(maxTokens >= 1, `${where}: maxTokens must be positive`);
							assert.ok(maxTokens <= ceiling, `${where}: maxTokens ${maxTokens} exceeded ceiling`);

							const fields = built.input.additionalModelRequestFields as AdditionalFields | undefined;
							const budget = fields?.reasoning_config?.budget_tokens;

							// The adaptive API sends no budget, so the level it *does* send
							// must be one whose server-derived budget fits — and must never
							// exceed what was asked for.
							if (built.thinkingEnabled && m.api === "adaptive") {
								const sent = fields?.output_config?.effort as ThinkingEffort | undefined;
								assert.ok(sent, `${where}: adaptive request sent no effort`);
								assert.ok(
									maxTokens >= minMaxTokensForEffort(sent!),
									`${where}: sent "${sent}" needing ${minMaxTokensForEffort(sent!)} with only ${maxTokens}`
								);
								assert.ok(
									THINKING_EFFORTS.indexOf(sent!) <= THINKING_EFFORTS.indexOf(effort),
									`${where}: effort was raised to "${sent}"`
								);
							}

							if (built.thinkingEnabled) {
								assert.ok(
									maxTokens >= MIN_THINKING_BUDGET + MIN_ANSWER_TOKENS,
									`${where}: thinking enabled with only ${maxTokens} output tokens`
								);
								if (budget !== undefined) {
									assert.ok(budget >= MIN_THINKING_BUDGET, `${where}: budget ${budget} below the floor`);
									assert.ok(budget < maxTokens, `${where}: budget ${budget} >= maxTokens ${maxTokens}`);
								}
							} else {
								assert.equal(fields, undefined, `${where}: thinking fields sent with thinking off`);
								// Thinking is dropped either because an explicit cap conflicts, or
								// because the adaptive API has no level small enough to fit.
								const explained =
									built.maxTokens.conflict !== undefined ||
									(m.api === "adaptive" && maxTokens < minMaxTokensForEffort("low"));
								assert.ok(explained, `${where}: thinking dropped without explanation`);
							}

							// Nobody chose a value at all, so the model ceiling must be used in full.
							if ((setting === undefined || setting === 0) && request === undefined) {
								assert.equal(
									maxTokens,
									ceiling,
									`${where}: unset setting produced ${maxTokens} rather than the ceiling`
								);
							}
						}
						}
					}
				}
			}
		});

		test("resolveMaxTokens falls back when the model reports no ceiling", () => {
			const noCeiling = resolveMaxTokens({ modelCeiling: 0 });
			assert.equal(noCeiling.maxTokens, LAST_RESORT_MAX_OUTPUT_TOKENS);

			const withFallback = resolveMaxTokens({ modelCeiling: undefined, fallbackCeiling: 32000 });
			assert.equal(withFallback.maxTokens, 32000);
			assert.equal(withFallback.ceiling, 32000);
		});

		test("adaptive thinking models get thinking + output_config effort", () => {
			const built = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-6", maxOutputTokens: 64000 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-6"),
				toolConfig: undefined,
				thinking: { enabled: true, effort: "high", budgetTokens: 0 },
			});
			assert.equal(built.thinkingEnabled, true);
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			assert.deepEqual(fields.thinking, { type: "adaptive" });
			assert.deepEqual(fields.output_config, { effort: "high" });
			assert.equal(fields.reasoning_config, undefined, "adaptive models must not get a token budget");
		});

		test("legacy thinking models get reasoning_config with a budget below maxTokens", () => {
			const built = buildRequestInput({
				model: { id: "anthropic.claude-3-7-sonnet-20250219-v1:0", maxOutputTokens: 8192 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-3-7-sonnet-20250219-v1:0"),
				toolConfig: undefined,
				thinking: { enabled: true, effort: "xhigh", budgetTokens: 0 },
			});
			const fields = built.input.additionalModelRequestFields as AdditionalFields;
			assert.equal(fields.thinking, undefined, "legacy models must not get the adaptive field");
			const reasoning = fields.reasoning_config;
			assert.ok(reasoning, "expected a reasoning_config block");
			assert.equal(reasoning.type, "enabled");
			assert.ok(
				reasoning.budget_tokens !== undefined &&
					reasoning.budget_tokens < built.input.inferenceConfig!.maxTokens!,
				"budget must leave room for the answer"
			);
			assert.ok(
				built.input.inferenceConfig!.maxTokens! - reasoning.budget_tokens! >= MIN_ANSWER_TOKENS,
				"the answer allowance must be usable, not a single token"
			);
		});

		test("thinking suppresses temperature, topP and a forced tool choice", () => {
			const built = buildRequestInput({
				// A legacy-temperature model, so temperature would otherwise be sent.
				model: { id: "anthropic.claude-3-7-sonnet-20250219-v1:0", maxOutputTokens: 8192 },
				converted: baseConverted,
				options: { modelOptions: { top_p: 0.5, temperature: 0.2 } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-3-7-sonnet-20250219-v1:0"),
				toolConfig: { tools: [], toolChoice: { tool: { name: "only_tool" } } },
				thinking: { enabled: true, effort: "low", budgetTokens: 0 },
			});
			assert.equal(built.input.inferenceConfig!.temperature, undefined);
			assert.equal(built.input.inferenceConfig!.topP, undefined);
			assert.deepEqual((built.input.toolConfig as { toolChoice?: unknown }).toolChoice, { auto: {} });
		});

		test("thinking is ignored by models without a reasoning mode", () => {
			const built = buildRequestInput({
				model: { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", maxOutputTokens: 8192 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-3-5-sonnet-20241022-v2:0"),
				toolConfig: undefined,
				thinking: { enabled: true, effort: "high", budgetTokens: 0 },
			});
			assert.equal(built.thinkingEnabled, false);
			assert.equal(built.input.additionalModelRequestFields, undefined);
			assert.equal(built.input.inferenceConfig!.temperature, 0.7, "temperature stays when thinking is inert");
		});

		test("effort levels map to increasing legacy token budgets", () => {
			// Anthropic's floor is 1024, and each level must be strictly larger than
			// the last or the setting has no observable effect.
			const budgets = (["low", "medium", "high", "xhigh"] as const).map(budgetForEffort);
			assert.ok(budgets[0] >= 1024, "the lowest budget must still clear Anthropic's minimum");
			for (let i = 1; i < budgets.length; i++) {
				assert.ok(budgets[i] > budgets[i - 1], `budget must increase at step ${i}: ${budgets.join(", ")}`);
			}
		});
	});

	suite("stream-processor cancellation", () => {
		/** A stream whose first read fails, as an aborted HTTP body does. */
		const failingStream = (message: string): AsyncIterable<never> => ({
			[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }),
		});
		const progress = { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

		test("suppresses stream error when cancellation was requested", async () => {
			// Cancelling aborts the HTTP request, which surfaces as a read error.
			const cts = new vscode.CancellationTokenSource();
			cts.cancel();
			const sp = new StreamProcessor();
			await assert.doesNotReject(
				sp.processStream(failingStream("stream broke"), progress, cts.token),
				"error during cancellation must be suppressed"
			);
		});

		test("rethrows stream error when not cancelled", async () => {
			const cts = new vscode.CancellationTokenSource();
			const sp = new StreamProcessor();
			await assert.rejects(
				sp.processStream(failingStream("stream broke"), progress, cts.token),
				/stream broke/,
				"error without cancellation must propagate"
			);
		});
	});

	suite("chat-request guards", () => {
		// Drive the real provider with a mocked config so the handler reaches its guards;
		// both guards throw BEFORE any Bedrock network call. Config mock restored in teardown.
		let originalGetConfiguration: typeof vscode.workspace.getConfiguration;
		setup(() => { originalGetConfiguration = vscode.workspace.getConfiguration; });
		teardown(() => setConfigurationProvider(originalGetConfiguration));

		const mockConfig = (over: Record<string, unknown> = {}) => {
			// nativeTokenCounting defaults to true in production, which would make the
			// handler issue a real CountTokens call before reaching the guard. Force it
			// off so these stay offline unit tests.
			const values: Record<string, unknown> = {
				region: 'us-east-1',
				authMethod: 'api-key',
				apiKey: 'bedrock-api-key-test',
				nativeTokenCounting: false,
				...over,
			};
			setConfigurationProvider((section?: string) => {
				if (section === 'languageModelChatProvider.bedrock') {
					return {
						get: (key: string) => values[key],
						has: () => true, inspect: () => undefined, update: async () => {},
					};
				}
				return originalGetConfiguration(section);
			});
		};
		const makeModel = (over: Partial<vscode.LanguageModelChatInformation> = {}) => ({
			id: "anthropic.claude-3-5-sonnet-20241022-v2:0", name: "m", family: "bedrock", version: "1.0.0",
			maxInputTokens: 100000, maxOutputTokens: 4096, capabilities: {}, ...over,
		} as unknown as vscode.LanguageModelChatInformation);
		const userMsg = (text: string): vscode.LanguageModelChatMessage => ({
			role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(text)], name: undefined,
		});

		test("rejects when more than 128 tools are supplied", async () => {
			mockConfig();
			const provider = new BedrockChatProvider(new ConfigurationService(), new AuthenticationService(new ConfigurationService()));
			const tools = Array.from({ length: 129 }, (_, i) => ({ name: `tool_${i}`, description: "", inputSchema: {} }));
			await assert.rejects(
				provider.provideLanguageModelChatResponse(makeModel(), [userMsg("hi")], { tools } as unknown as vscode.LanguageModelChatRequestHandleOptions, { report: () => {} }, new vscode.CancellationTokenSource().token),
				/more than 128 tools/,
			);
		});

		test("rejects when message exceeds the model token limit", async () => {
			mockConfig();
			const provider = new BedrockChatProvider(new ConfigurationService(), new AuthenticationService(new ConfigurationService()));
			await assert.rejects(
				provider.provideLanguageModelChatResponse(makeModel({ maxInputTokens: 1 }), [userMsg("this message is definitely more than one token long")], {} as vscode.LanguageModelChatRequestHandleOptions, { report: () => {} }, new vscode.CancellationTokenSource().token),
				/exceeds token limit/,
			);
		});
	});

	suite("authentication.service env-var lifecycle", () => {
		let saved: string | undefined;
		setup(() => { saved = process.env.AWS_BEARER_TOKEN_BEDROCK; });
		teardown(() => { if (saved === undefined) { delete process.env.AWS_BEARER_TOKEN_BEDROCK; } else { process.env.AWS_BEARER_TOKEN_BEDROCK = saved; } });

		test("api-key sets AWS_BEARER_TOKEN_BEDROCK; switching away deletes it", () => {
			const auth = new AuthenticationService(new ConfigurationService());
			const creds = auth.getCredentials({ method: 'api-key', apiKey: 'bedrock-api-key-xyz' });
			assert.equal(creds, undefined, "api-key auth returns no explicit credentials (uses env var)");
			assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, 'bedrock-api-key-xyz');

			auth.getCredentials({ method: 'default' });
			assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, undefined, "non-api-key method must clear the bearer token");
		});
	});

	suite("validation/multi-tool", () => {
		test("accepts multiple tool calls each paired with a result; throws on orphan", () => {
			const callA = new vscode.LanguageModelToolCallPart("a", "toolA", {});
			const callB = new vscode.LanguageModelToolCallPart("b", "toolB", {});
			const resA = new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]);
			const resB = new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart("rb")]);

			const paired: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [resA, resB], name: undefined },
			];
			assert.doesNotThrow(() => validateRequest(paired));

			const orphan: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [resA], name: undefined },
			];
			assert.throws(() => validateRequest(orphan), "missing result for callB must throw");
		});
	});

	suite("converters/messages mistral JSON tool results", () => {
		const mistral = "mistral.mistral-large-2407-v1:0";
		const toolResultBlock = (out: ReturnType<typeof convertMessages>) =>
			out.messages
				.flatMap((m) => m.content)
				.find((c): c is BedrockToolResultBlock => "toolResult" in c)?.toolResult?.content;

		test("valid JSON tool result is emitted as a json block", () => {
			const msgs: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelToolCallPart("c1", "t", {})], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart("c1", [new vscode.LanguageModelTextPart('{"answer":42}')])], name: undefined },
			];
			const content = toolResultBlock(convertMessages(msgs, mistral));
			assert.deepEqual(content, [{ json: { answer: 42 } }]);
		});

		test("invalid JSON tool result falls back to a text block", () => {
			const msgs: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelToolCallPart("c1", "t", {})], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart("c1", [new vscode.LanguageModelTextPart("not json")])], name: undefined },
			];
			const content = toolResultBlock(convertMessages(msgs, mistral));
			assert.deepEqual(content, [{ text: "not json" }]);
		});
	});

	suite("converters/tools toolChoice by provider", () => {
		const tool = { name: "do_x", description: "", inputSchema: {} };

		test("mistral (no toolChoice support) emits no toolChoice", () => {
			const out = convertTools({ tools: [tool] } as vscode.LanguageModelChatRequestHandleOptions, "mistral.mistral-large-2407-v1:0");
			assert.ok(out, "tools still converted");
			assert.equal(out!.toolChoice, undefined, "mistral must not set toolChoice");
		});

		test("anthropic with ToolMode.Required and >1 tool throws", () => {
			assert.throws(() =>
				convertTools({ toolMode: vscode.LanguageModelChatToolMode.Required, tools: [tool, { ...tool, name: "do_y" }] } as vscode.LanguageModelChatRequestHandleOptions, "anthropic.claude-3-5-sonnet-20241022-v2:0"),
				/more than one tool/,
			);
		});
	});

	suite("inference profile resolution", () => {
		// The routing table every invocation flows through: bare model ID -> the actual
		// target (user override, geo system profile, or bare). Covers the happy paths and
		// the failure/edge paths so a change here can't silently misroute or leak geography.
		const MID = "anthropic.claude-haiku-4-5-20251001-v1:0";
		const prof = (prefix: string) => `${prefix}.${MID}`;
		const set = (...ids: string[]) => new Set(ids);
		const NO_OVERRIDES: Record<string, string> = {};

		test("regionGeoPrefix maps a region to its broad geo pool", () => {
			assert.equal(regionGeoPrefix("us-east-1"), "us.");
			assert.equal(regionGeoPrefix("eu-west-1"), "eu.");
			assert.equal(regionGeoPrefix("ap-south-1"), "apac.");
			// every ap-* region rolls up to the apac. geo (au./jp. are handled generically below)
			assert.equal(regionGeoPrefix("ap-southeast-2"), "apac.");
			assert.equal(regionGeoPrefix("ap-northeast-1"), "apac.");
		});

		// --- happy paths ---
		test("user override wins over every system profile", () => {
			const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
			const target = resolveInvocationTarget(MID, set(prof("us"), prof("global")), "us-east-1", { [MID]: arn });
			assert.equal(target, arn);
		});

		test("override applies even when no system profile exists for the region", () => {
			const arn = "arn:aws:bedrock:ap-southeast-2:123456789012:application-inference-profile/def456";
			assert.equal(resolveInvocationTarget(MID, set(), "ap-southeast-2", { [MID]: arn }), arn);
		});

		test("matches the region's own geo profile (us / eu / generic apac)", () => {
			assert.equal(resolveInvocationTarget(MID, set(prof("us"), prof("eu")), "us-east-1", NO_OVERRIDES), prof("us"));
			assert.equal(resolveInvocationTarget(MID, set(prof("us"), prof("eu")), "eu-west-1", NO_OVERRIDES), prof("eu"));
			assert.equal(resolveInvocationTarget(MID, set(prof("apac"), prof("us")), "ap-south-1", NO_OVERRIDES), prof("apac"));
		});

		test("in-region residency pool (au.) is preferred over the worldwide global. pool", () => {
			assert.equal(resolveInvocationTarget(MID, set(prof("au"), prof("global")), "ap-southeast-2", NO_OVERRIDES), prof("au"));
		});

		test("in-region residency pool (jp.) is preferred over global. — no country hard-coding needed", () => {
			// The generic "any non-global in-region pool beats global." rule keeps a Japan
			// caller in-country without the resolver ever naming Japan.
			assert.equal(resolveInvocationTarget(MID, set(prof("jp"), prof("global")), "ap-northeast-1", NO_OVERRIDES), prof("jp"));
		});

		test("the region's own geo pool (apac.) wins over another in-region pool (throughput-first)", () => {
			assert.equal(resolveInvocationTarget(MID, set(prof("apac"), prof("au")), "ap-southeast-2", NO_OVERRIDES), prof("apac"));
		});

		test("falls back to global. when no in-geo profile is present", () => {
			assert.equal(resolveInvocationTarget(MID, set(prof("global")), "us-east-1", NO_OVERRIDES), prof("global"));
		});

		// --- unhappy / edge paths ---
		test("catch-all: returns a callable profile when no preferred prefix matches", () => {
			// e.g. a us-gov caller ("us." prefix won't match "us-gov.") whose only candidate
			// is the gov profile — still routed through it rather than dropped.
			const gov = `us-gov.${MID}`;
			assert.equal(resolveInvocationTarget(MID, set(gov), "us-gov-east-1", NO_OVERRIDES), gov);
		});

		test("returns undefined (invoke bare) when no profile matches the model", () => {
			const otherModel = `us.anthropic.claude-3-5-sonnet-20241022-v2:0`;
			assert.equal(resolveInvocationTarget(MID, set(otherModel), "us-east-1", NO_OVERRIDES), undefined);
		});

		test("returns undefined when nothing is available at all", () => {
			assert.equal(resolveInvocationTarget(MID, set(), "us-east-1", NO_OVERRIDES), undefined);
		});

		test("substring model IDs do not cross-match (endsWith on '.<id>')", () => {
			// A profile for a *different* model must never be chosen for MID.
			const decoy = `apac.anthropic.claude-haiku-4-5-20251001-v1:0-preview`;
			assert.equal(resolveInvocationTarget(MID, set(decoy), "ap-south-1", NO_OVERRIDES), undefined);
		});

		test("keeping the bare model ID lets getModelProfile suppress temperature for Claude 4+", () => {
			// The whole point of routing at the wire level: model.id stays bare, so capability
			// detection sees "anthropic.claude-*-4*" and omits temperature (Bedrock rejects it).
			assert.equal(getModelProfile(MID).supportsTemperature, false);
		});
	});

	suite("manual models (SCP fallback)", () => {
		test("maps a minimal manual model into a streaming TEXT summary", () => {
			const sum = manualModelToSummary({ id: "anthropic.claude-opus-4-8" });
			assert.equal(sum.modelId, "anthropic.claude-opus-4-8");
			assert.equal(sum.modelName, "anthropic.claude-opus-4-8");
			assert.equal(sum.providerName, "anthropic");
			assert.ok(sum.responseStreamingSupported, "must be streaming to survive the filter");
			assert.ok(sum.outputModalities.includes("TEXT"), "must output TEXT to survive the filter");
			assert.ok(!sum.inputModalities.includes("IMAGE"), "vision defaults off");
		});

		test("honors name and vision", () => {
			const sum = manualModelToSummary({ id: "anthropic.claude-opus-4-8", name: "Opus 4.8", vision: true });
			assert.equal(sum.modelName, "Opus 4.8");
			assert.ok(sum.inputModalities.includes("IMAGE"));
		});

		test("a manual inferenceProfile routes like an override", () => {
			// Even with NO discovered profiles, a manual model's inferenceProfile must
			// be usable as an override so Converse targets the cross-region profile.
			const id = "anthropic.claude-opus-4-8";
			const profile = "global.anthropic.claude-opus-4-8";
			assert.equal(resolveInvocationTarget(id, new Set(), "us-east-1", { [id]: profile }), profile);
		});
	});

	suite("configuration: inference profile overrides", () => {
		let original: typeof vscode.workspace.getConfiguration;
		setup(() => { original = vscode.workspace.getConfiguration; });
		teardown(() => setConfigurationProvider(original));

		test("defaults to an empty map when unset", () => {
			setConfigurationProvider(() => ({ get: () => undefined }));
			assert.deepEqual(new ConfigurationService().getInferenceProfileOverrides(), {});
		});

		test("returns the configured map verbatim", () => {
			const map = { "anthropic.claude-haiku-4-5-20251001-v1:0": "arn:aws:bedrock:ap-southeast-2:123456789012:application-inference-profile/abc123" };
			setConfigurationProvider(() => ({ get: (k: string) => (k === "inferenceProfileOverrides" ? map : undefined) }));
			assert.deepEqual(new ConfigurationService().getInferenceProfileOverrides(), map);
		});
	});

	suite("configuration: token-limit sentinels", () => {
		let original: typeof vscode.workspace.getConfiguration;
		setup(() => { original = vscode.workspace.getConfiguration; });
		teardown(() => setConfigurationProvider(original));

		/** Stub one setting key, everything else unset. */
		const withSetting = (key: string, value: unknown) =>
			setConfigurationProvider(() => ({ get: (k: string) => (k === key ? value : undefined) }));

		test("getMaxOutputTokens returns undefined, never 0, for the unset default", () => {
			// The bug lived in the seam: the service returned 0 as "use the model
			// maximum", and the caller selected it with `??`, which does not treat 0
			// as absent. Destroying the sentinel here is what makes the seam safe, so
			// the service is asserted directly rather than only through the builder.
			for (const value of [undefined, 0, -5, Number.NaN, "nonsense"]) {
				withSetting("maxOutputTokens", value);
				assert.strictEqual(
					new ConfigurationService().getMaxOutputTokens(),
					undefined,
					`value ${String(value)} must read as unset`
				);
			}
		});

		test("getMaxOutputTokens returns a positive integer when set", () => {
			withSetting("maxOutputTokens", 8192);
			assert.strictEqual(new ConfigurationService().getMaxOutputTokens(), 8192);
			withSetting("maxOutputTokens", 8192.7);
			assert.strictEqual(new ConfigurationService().getMaxOutputTokens(), 8192, "must be an integer");
		});

		test("getThinkingBudgetTokens returns undefined for the derive-from-effort sentinel", () => {
			for (const value of [undefined, 0, -1]) {
				withSetting("thinking.budgetTokens", value);
				assert.strictEqual(new ConfigurationService().getThinkingBudgetTokens(), undefined);
			}
		});

		test("getThinkingBudgetTokens raises sub-floor values to Anthropic's minimum", () => {
			withSetting("thinking.budgetTokens", 100);
			assert.strictEqual(new ConfigurationService().getThinkingBudgetTokens(), MIN_THINKING_BUDGET);
			withSetting("thinking.budgetTokens", 20000);
			assert.strictEqual(new ConfigurationService().getThinkingBudgetTokens(), 20000);
		});

		test("the service's unset values feed the builder without capping the model", () => {
			// End-to-end over the seam: what the service actually returns for a
			// default install must produce the model ceiling, not 1.
			setConfigurationProvider(() => ({ get: () => undefined }));
			const config = new ConfigurationService();
			const built = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-6", maxOutputTokens: 128000 },
				converted: {
					messages: [{ role: "user", content: [{ text: "hi" }] }],
					system: [],
				},
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-6"),
				maxOutputTokensOverride: config.getMaxOutputTokens(),
				thinking: { enabled: true, effort: "high", budgetTokens: config.getThinkingBudgetTokens() },
			});
			assert.equal(built.input.inferenceConfig!.maxTokens, 128000);
			assert.equal(built.thinkingEnabled, true);
		});
	});

	suite("token-limit error guidance", () => {
		test("a too-small setting names the setting and the 0 remedy", () => {
			const msg = describeThinkingBudgetConflict({
				maxTokens: 500,
				requiredMaxTokens: 20480,
				effort: "high",
				source: "setting",
				ceiling: 128000,
			});
			assert.ok(msg.includes("maxOutputTokens"), "must name the setting");
			assert.ok(msg.includes("0"), "must offer the model-maximum remedy");
			assert.ok(msg.includes("high"), "must name the effort level");
		});

		test("a cap the model cannot reach tells the user to lower the effort instead", () => {
			// requiredMaxTokens must exceed the ceiling for this branch: when the
			// requirement fits within the model's own maximum, setting the cap to 0 is
			// the correct advice, and only when it does not is lowering the effort the
			// only remedy.
			const msg = describeThinkingBudgetConflict({
				maxTokens: 500,
				requiredMaxTokens: minMaxTokensForEffort("xhigh"),
				effort: "xhigh",
				source: "setting",
				ceiling: 4096,
			});
			assert.ok(msg.includes("thinking.effort"), `must point at the effort setting, got: ${msg}`);
			assert.ok(msg.includes("4,096"), "must state the model's actual maximum");
			assert.ok(!msg.includes("to 0 to use"), "offering the model maximum would not help here");
		});

		test("Bedrock's max_tokens/budget_tokens rejection is translated", () => {
			const raw =
				"The model returned the following errors: `max_tokens` must be greater than `thinking.budget_tokens`.";
			const explained = explainBedrockValidationError(raw, {
				maxTokens: 1,
				effort: "high",
				thinkingEnabled: true,
			});
			assert.ok(explained, "this is the reported error and must be recognized");
			assert.ok(explained!.includes("maxOutputTokens"), "must name a setting the user can change");
			assert.ok(explained!.includes(raw), "must keep the original for diagnosis");
		});

		test("unrelated errors are left alone", () => {
			assert.equal(
				explainBedrockValidationError("AccessDeniedException: not authorized", { thinkingEnabled: true }),
				undefined
			);
		});
	});

	suite("effort availability", () => {
		const CEILING = 128000;

		test("every level fits when the output limit is unset", () => {
			const all = assessAllEfforts({ ceiling: CEILING, api: "adaptive" });
			assert.equal(all.length, THINKING_EFFORTS.length);
			for (const a of all) {
				assert.equal(a.fit, "fits", `${a.effort} should fit a ${CEILING}-token ceiling`);
				assert.equal(iconForAvailability(a), undefined, `${a.effort} needs no warning icon`);
				assert.equal(detailForAvailability(a), undefined, `${a.effort} needs no detail`);
			}
		});

		test("a small explicit cap makes high levels unusable", () => {
			const all = assessAllEfforts({ ceiling: CEILING, settingMaxTokens: 500, api: "adaptive" });
			for (const a of all) {
				assert.equal(a.fit, "impossible", `${a.effort} cannot work with a 500-token cap`);
				assert.equal(iconForAvailability(a), "error");
				assert.equal(a.limitedBySetting, true, "the setting is what constrains it");
				const detail = detailForAvailability(a);
				assert.ok(detail?.includes("maxOutputTokens"), "detail must name the setting");
				assert.ok(detail?.includes("0"), "detail must offer the model-maximum remedy");
			}
		});

		test("a model ceiling too small for a level is reported as the model's limit, not the setting's", () => {
			// A budget-API model can shrink its budget, so a 4096 ceiling is usable but
			// tight rather than impossible — and the cause is the model, not a setting.
			const a = assessEffort({ effort: "xhigh", ceiling: 4096, api: "budget" });
			assert.equal(a.fit, "tight");
			assert.equal(a.limitedBySetting, false);
			assert.equal(iconForAvailability(a), "warning");
			const detail = detailForAvailability(a);
			assert.ok(detail?.includes("this model allows"), `expected a model-limited message, got: ${detail}`);
			assert.ok(!detail?.includes("maxOutputTokens"), "must not blame a setting the user did not set");
		});

		test("an adaptive model whose ceiling cannot fit even the lowest level reports impossible", () => {
			// The adaptive API cannot shrink a budget — the service derives it from the
			// effort level — so a ceiling below the lowest level's requirement means no
			// reasoning at all, not merely reduced reasoning.
			const a = assessEffort({ effort: "xhigh", ceiling: 4096, api: "adaptive" });
			assert.equal(a.fit, "impossible", "4096 cannot fit even low, which needs 6144");
			assert.equal(iconForAvailability(a), "error");
			assert.ok(detailForAvailability(a)?.includes("Pick a lower level"));
		});

		test("an adaptive level that will be silently reduced says which level runs instead", () => {
			// The case behind the reported production failure: enough room for some
			// reasoning, but not the level requested.
			const a = assessEffort({ effort: "high", ceiling: 128000, settingMaxTokens: 8192, api: "adaptive" });
			assert.equal(a.fit, "tight");
			assert.equal(a.effectiveEffort, "low", "8192 only fits low");
			assert.ok(
				describeAvailability(a).includes('would run as "low"'),
				`description must name the level that runs, got: ${describeAvailability(a)}`
			);
			assert.ok(detailForAvailability(a)?.includes("derives its reasoning budget"));
		});

		test("descriptions always state the budget, and the shortfall when there is one", () => {
			const fits = assessEffort({ effort: "low", ceiling: CEILING, api: "adaptive" });
			assert.ok(describeAvailability(fits).includes("2,048"), "must state the budget");

			const blocked = assessEffort({ effort: "high", ceiling: CEILING, settingMaxTokens: 500, api: "adaptive" });
			const text = describeAvailability(blocked);
			assert.ok(text.includes("16,384"), "must still state the budget");
			assert.ok(text.includes("500"), "must state what is actually available");
		});

		test("availability agrees with what the request builder would send", () => {
			// The point of reusing resolveMaxTokens: the quick pick's advice and the
			// wire request must never disagree, which is the failure mode a second copy
			// of the precedence logic would reintroduce.
			for (const setting of [undefined, 500, 4096, 32000]) {
				for (const effort of THINKING_EFFORTS) {
					const a = assessEffort({ effort, ceiling: CEILING, settingMaxTokens: setting, api: "adaptive" });
					const built = buildRequestInput({
						model: { id: "anthropic.claude-sonnet-4-6", maxOutputTokens: CEILING },
						converted: {
							messages: [{ role: "user", content: [{ text: "hi" }] }],
							system: [],
						},
						options: {} as vscode.LanguageModelChatRequestHandleOptions,
						profile: getModelProfile("anthropic.claude-sonnet-4-6"),
						maxOutputTokensOverride: setting,
						thinking: { enabled: true, effort, budgetTokens: 0 },
					});
					const where = `effort=${effort} setting=${String(setting)}`;
					assert.equal(a.resolved, built.input.inferenceConfig!.maxTokens, `${where}: limits disagree`);
					assert.equal(
						a.fit === "impossible",
						!built.thinkingEnabled,
						`${where}: "impossible" must match thinking actually being dropped`
					);
				}
			}
		});
	});

	suite("settings advisories", () => {
		test("an unset output limit produces no advisory", () => {
			assert.deepEqual(
				checkTokenSettings({ maxOutputTokens: undefined, thinkingEnabled: true, thinkingEffort: "high" }),
				[]
			);
		});

		test("a tiny output limit is flagged regardless of thinking", () => {
			const advisories = checkTokenSettings({
				maxOutputTokens: 100,
				thinkingEnabled: false,
				thinkingEffort: "high",
			});
			assert.equal(advisories.length, 1);
			assert.ok(advisories[0].message.includes("too small for normal use"));
			assert.ok(advisories[0].message.includes("0"), "must offer the model-maximum remedy");
		});

		test("a limit too small for the current effort is flagged only while thinking is on", () => {
			const required = minMaxTokensForEffort("xhigh");
			const on = checkTokenSettings({
				maxOutputTokens: 4096,
				thinkingEnabled: true,
				thinkingEffort: "xhigh",
				requiredForEffort: required,
			});
			assert.equal(on.length, 1);
			assert.ok(on[0].message.includes("xhigh"));

			const off = checkTokenSettings({
				maxOutputTokens: 4096,
				thinkingEnabled: false,
				thinkingEffort: "xhigh",
				requiredForEffort: required,
			});
			assert.deepEqual(off, [], "an unused effort level must not be warned about");
		});

		test("a budget that does not fit the cap is flagged", () => {
			const advisories = checkTokenSettings({
				maxOutputTokens: 8192,
				thinkingEnabled: true,
				thinkingEffort: "medium",
				thinkingBudgetTokens: 8192,
				requiredForEffort: minMaxTokensForEffort("medium"),
			});
			assert.ok(
				advisories.some((a) => a.message.includes("budgetTokens")),
				`expected a budget advisory, got: ${advisories.map((a) => a.id).join(", ")}`
			);
		});

		test("advisory IDs encode the values, so a new bad value is warned about again", () => {
			const first = checkTokenSettings({ maxOutputTokens: 100, thinkingEnabled: false, thinkingEffort: "low" });
			const second = checkTokenSettings({ maxOutputTokens: 200, thinkingEnabled: false, thinkingEffort: "low" });
			assert.notEqual(first[0].id, second[0].id, "changing the value must not be suppressed as a duplicate");

			const repeat = checkTokenSettings({ maxOutputTokens: 100, thinkingEnabled: false, thinkingEffort: "low" });
			assert.equal(first[0].id, repeat[0].id, "the same value must be suppressible");
		});

		test("a healthy configuration is silent", () => {
			assert.deepEqual(
				checkTokenSettings({
					maxOutputTokens: 64000,
					thinkingEnabled: true,
					thinkingEffort: "high",
					requiredForEffort: minMaxTokensForEffort("high"),
				}),
				[]
			);
		});
	});

	suite("model.service ceiling provenance", () => {
		test("a manual override wins over everything", () => {
			const r = resolveOutputCeiling({
				modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				manual: 60000,
				openRouter: 128000,
			});
			assert.equal(r.maxOutputTokens, 60000);
			assert.equal(r.source, "manual");
		});

		test("OpenRouter is preferred over the conservative table, even when larger", () => {
			// The whole point: the table caps Claude 4+ at 32000, but Opus 5 allows
			// 128000, so a user whose network reaches OpenRouter should get the real
			// figure rather than losing three quarters of their output budget.
			const r = resolveOutputCeiling({ modelId: "anthropic.claude-opus-5", openRouter: 128000 });
			assert.equal(r.maxOutputTokens, 128000);
			assert.equal(r.source, "openrouter");
			assert.equal(r.tableValue, 32000, "the table value is retained for reporting");
		});

		test("the table is used, and identified as such, when nothing else is available", () => {
			const r = resolveOutputCeiling({ modelId: "anthropic.claude-opus-5" });
			assert.equal(r.maxOutputTokens, defaultMaxOutputTokens("anthropic.claude-opus-5"));
			assert.equal(r.source, "table");
		});

		test("unusable reported values fall through instead of capping the model", () => {
			for (const bad of [0, -1, Number.NaN, undefined]) {
				const r = resolveOutputCeiling({ modelId: "anthropic.claude-opus-5", openRouter: bad });
				assert.equal(r.source, "table", `openRouter=${String(bad)} must not be trusted`);
			}
			const manualBad = resolveOutputCeiling({
				modelId: "anthropic.claude-opus-5",
				manual: 0,
				openRouter: 128000,
			});
			assert.equal(manualBad.source, "openrouter", "a 0 manual override must not win");
		});
	});

	suite("configuration report", () => {
		const baseSnapshot = {
			region: "us-east-1",
			authMethod: "api-key" as const,
			authResolved: true,
			thinking: {
				enabled: true,
				effort: "high" as const,
				budgetTokens: undefined,
				display: "native",
				showEffortVariants: false,
			},
			maxOutputTokens: undefined,
			promptCaching: true,
			nativeTokenCounting: true,
			manualModelCount: 0,
			inferenceProfileOverrideCount: 0,
			discoveryPending: false,
			models: [
				{
					modelId: "anthropic.claude-opus-5",
					maxInputTokens: 1000000,
					maxOutputTokens: 128000,
					ceilingSource: "openrouter" as const,
					tableValue: 32000,
				},
			],
		};

		test("reports the resolved limit, not the raw setting", () => {
			const report = formatConfigurationReport(baseSnapshot);
			assert.ok(report.includes("128,000"), "must show the resolved ceiling");
			assert.ok(report.includes("use each model's own maximum"), "must explain the 0 default");
			assert.ok(report.includes("us-east-1"));
			assert.ok(report.includes("high"));
		});

		test("calls out a conflicting configuration", () => {
			const report = formatConfigurationReport({ ...baseSnapshot, maxOutputTokens: 500 });
			assert.ok(report.includes("too small for reasoning"), "the blocked model must be marked");
			assert.ok(report.includes("cannot currently run with reasoning enabled"), "must summarize the problem");
		});

		test("calls out models that fell back to the built-in table", () => {
			const report = formatConfigurationReport({
				...baseSnapshot,
				models: [{ ...baseSnapshot.models[0], ceilingSource: "table" as const, tableValue: undefined }],
			});
			assert.ok(report.includes("built-in ceiling defaults"), "the fallback must be visible");
		});

		test("says so when discovery has not run, rather than printing an empty table", () => {
			const report = formatConfigurationReport({ ...baseSnapshot, discoveryPending: true, models: [] });
			assert.ok(report.includes("has not run yet"));
		});

		test("never contains credentials", () => {
			// The report exists to be pasted into bug reports, so this is load-bearing.
			const report = formatConfigurationReport({
				...baseSnapshot,
				authMethod: "profile",
				authDetail: "my-profile",
			});
			assert.ok(report.includes("no credentials are included"), "must say it is safe to paste");
			for (const term of ["apiKey", "secretAccessKey", "sessionToken", "AWS_BEARER"]) {
				assert.ok(!report.includes(term), `report must not mention ${term}`);
			}
		});
	});

	suite("model.service output-token ceilings", () => {
		test("modern Claude models are not capped at the legacy 4096", () => {
			// A flat 4096 fallback is what truncated large tool calls mid-JSON.
			assert.equal(defaultMaxOutputTokens("anthropic.claude-sonnet-4-5-20250929-v1:0"), 32000);
			assert.equal(defaultMaxOutputTokens("us.anthropic.claude-sonnet-5"), 32000);
			assert.equal(defaultMaxOutputTokens("anthropic.claude-3-7-sonnet-20250219-v1:0"), 32000);
		});

		test("older Claude models keep their real, lower ceilings", () => {
			// Bedrock rejects the whole request when maxTokens exceeds the model's
			// limit, so guessing high here would break every call, not just big ones.
			assert.equal(defaultMaxOutputTokens("anthropic.claude-3-5-sonnet-20241022-v2:0"), 8192);
			assert.equal(defaultMaxOutputTokens("anthropic.claude-3-haiku-20240307-v1:0"), 4096);
		});

		test("non-Anthropic models keep the conservative default", () => {
			assert.equal(defaultMaxOutputTokens("mistral.mistral-large-2407-v1:0"), 4096);
			assert.equal(defaultMaxOutputTokens("amazon.nova-pro-v1:0"), 4096);
		});

		test("an unrecognized Claude ID assumes a modern ceiling", () => {
			assert.equal(defaultMaxOutputTokens("anthropic.claude-something-new"), 32000);
		});
	});

	suite("converters/cache-points", () => {
		const profile = getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0");
		const filler = (n: number) => "x".repeat(n);
		// Comfortably past the ~1024-token minimum cacheable prefix.
		const bigText = filler(8000);

		const convo = (): BedrockMessage[] => [
			{ role: "user", content: [{ text: bigText }] },
			{ role: "assistant", content: [{ text: "ok" }] },
			{ role: "user", content: [{ text: "and now?" }] },
		];

		test("marks tools, system and the trailing pair of user messages", () => {
			const out = applyCachePoints(
				{
					messages: convo(),
					system: [{ text: "you are a helpful assistant" }],
					toolConfig: { tools: [{ toolSpec: { name: "t", description: "d", inputSchema: { json: {} } } }] },
				},
				profile,
				true
			);

			assert.equal(out.inserted, 4, "tools + system + two user messages");
			assert.ok(out.system.some((b) => "cachePoint" in b));
			assert.ok(out.toolConfig!.tools.some((t) => "cachePoint" in t));
			assert.ok(out.messages[0].content.some((c) => "cachePoint" in c), "older user message keeps its checkpoint");
			assert.ok(out.messages[2].content.some((c) => "cachePoint" in c), "newest user message is marked");
			assert.ok(!out.messages[1].content.some((c) => "cachePoint" in c), "assistant turns are not marked");
		});

		test("never exceeds the model's checkpoint budget", () => {
			const capped = { ...profile, maxCachePoints: 2 };
			const out = applyCachePoints(
				{
					messages: convo(),
					system: [{ text: "sys" }],
					toolConfig: { tools: [{ toolSpec: { name: "t", description: "d", inputSchema: { json: {} } } }] },
				},
				capped,
				true
			);
			assert.equal(out.inserted, 2);
		});

		test("does nothing when disabled, unsupported, or the prefix is too short", () => {
			const full = {
				messages: convo(),
				system: [{ text: "sys" }] as BedrockSystemBlock[],
				toolConfig: undefined,
			};

			assert.equal(applyCachePoints(full, profile, false).inserted, 0, "disabled by setting");
			assert.equal(
				applyCachePoints(full, getModelProfile("mistral.mistral-large-2407-v1:0"), true).inserted,
				0,
				"model does not support caching"
			);
			// A checkpoint below the minimum cacheable size is billed as a write and
			// never read back, so it is pure overhead.
			assert.equal(
				applyCachePoints({ messages: [{ role: "user", content: [{ text: "hi" }] }], system: [] }, profile, true)
					.inserted,
				0,
				"prefix below the minimum cacheable size"
			);
		});

		test("does not mutate its input", () => {
			const messages = convo();
			const system: BedrockSystemBlock[] = [{ text: "sys" }];
			const before = JSON.stringify({ messages, system });
			applyCachePoints({ messages, system }, profile, true);
			assert.equal(JSON.stringify({ messages, system }), before, "caller's arrays must be untouched");
		});

		test("is idempotent, so re-applying cannot stack checkpoints", () => {
			const first = applyCachePoints({ messages: convo(), system: [{ text: "sys" }] }, profile, true);
			const second = applyCachePoints(first, profile, true);
			assert.equal(second.inserted, 0);
		});
	});

	suite("converters/messages reconciliation", () => {
		const toolUse = (id: string): BedrockMessage => ({
			role: "assistant",
			content: [{ toolUse: { toolUseId: id, name: "read_file", input: {} } }],
		});
		const toolResult = (id: string): BedrockMessage => ({
			role: "user",
			content: [{ toolResult: { toolUseId: id, content: [{ text: "ok" }], status: "success" } }],
		});

		test("a matched pair passes through untouched", () => {
			const out = reconcileToolBlocks([toolUse("a"), toolResult("a")]);
			assert.equal(out.length, 2);
			assert.equal(out[1].content.length, 1);
		});

		test("drops a tool result with no preceding tool call", () => {
			// Bedrock answers this with a 400 that names neither the message nor the id.
			const out = reconcileToolBlocks([{ role: "user", content: [{ text: "hi" }] }, toolResult("ghost")]);
			assert.equal(out.length, 1, "the orphan message had nothing left, so it is gone");
			assert.ok("text" in out[0].content[0]);
		});

		test("drops a duplicate tool result for the same id", () => {
			const dup: BedrockMessage = {
				role: "user",
				content: [...toolResult("a").content, ...toolResult("a").content],
			};
			const out = reconcileToolBlocks([toolUse("a"), dup]);
			assert.equal(out[1].content.length, 1);
		});

		test("synthesizes an error result for an unanswered tool call", () => {
			const out = reconcileToolBlocks([
				{
					role: "assistant",
					content: [
						{ toolUse: { toolUseId: "a", name: "read_file", input: {} } },
						{ toolUse: { toolUseId: "b", name: "read_file", input: {} } },
					],
				},
				toolResult("a"),
			]);

			const results = out[1].content.filter((c) => "toolResult" in c) as Array<{
				toolResult: { toolUseId: string; status?: string };
			}>;
			assert.equal(results.length, 2, "every call must be answered");
			const synthetic = results.find((r) => r.toolResult.toolUseId === "b");
			assert.ok(synthetic, "missing result for b was not synthesized");
			assert.equal(synthetic!.toolResult.status, "error");
		});

		test("appends results when the conversation ends on a tool call", () => {
			const out = reconcileToolBlocks([{ role: "user", content: [{ text: "go" }] }, toolUse("a")]);
			assert.equal(out.length, 3);
			assert.equal(out[2].role, "user");
			assert.ok("toolResult" in out[2].content[0]);
		});

		test("leaves an ordinary conversation alone", () => {
			const plain: BedrockMessage[] = [
				{ role: "user", content: [{ text: "hi" }] },
				{ role: "assistant", content: [{ text: "hello" }] },
			];
			assert.deepEqual(reconcileToolBlocks(plain), plain);
		});
	});

	suite("converters/messages tool-result text", () => {
		test("reads text out of every shape a tool result arrives in", () => {
			assert.equal(collectToolResultText({ content: [new vscode.LanguageModelTextPart("from part")] }), "from part");
			assert.equal(collectToolResultText({ content: ["raw string"] }), "raw string");
			assert.equal(collectToolResultText({ content: [{ value: "value prop" }] }), "value prop");
			assert.equal(collectToolResultText({ content: [{ text: "text prop" }] }), "text prop");
		});

		test("describes binary content instead of dropping it", () => {
			const out = collectToolResultText({
				content: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
			});
			assert.ok(out.includes("image/png"), `expected the mime type in ${JSON.stringify(out)}`);
		});

		test("falls back to JSON for a structured result", () => {
			const out = collectToolResultText({ content: [{ rows: [1, 2] }] });
			assert.ok(out.includes("rows"), `expected serialized content in ${JSON.stringify(out)}`);
		});

		test("empty or absent content yields an empty string", () => {
			assert.equal(collectToolResultText({ content: [] }), "");
			assert.equal(collectToolResultText({}), "");
		});
	});

	suite("token estimation", () => {
		const estimator = new TokenEstimator();
		const model = { id: "anthropic.claude-sonnet-4-5-20250929-v1:0" } as vscode.LanguageModelChatInformation;

		test("counts tool calls, tool results and images, not just text", () => {
			// Counting text only is why the context indicator read near-empty during a
			// tool-heavy session.
			const textOnly = estimator.estimateMessageTokens({
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("hi")],
			} as vscode.LanguageModelChatMessage);

			const withToolCall = estimator.estimateMessageTokens({
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelToolCallPart("call_1", "replace_string_in_file", {
						filePath: "/a/b.ts",
						newString: "x".repeat(4000),
					}),
				],
			} as vscode.LanguageModelChatMessage);

			const withToolResult = estimator.estimateMessageTokens({
				role: vscode.LanguageModelChatMessageRole.User,
				content: [{ callId: "call_1", content: [new vscode.LanguageModelTextPart("y".repeat(4000))] }],
			} as unknown as vscode.LanguageModelChatMessage);

			const withImage = estimator.estimateMessageTokens({
				role: vscode.LanguageModelChatMessageRole.User,
				content: [{ mimeType: "image/png", data: new Uint8Array(16) }],
			} as unknown as vscode.LanguageModelChatMessage);

			assert.ok(withToolCall > 900, `tool call arguments must be counted, got ${withToolCall}`);
			assert.ok(withToolResult > 900, `tool result content must be counted, got ${withToolResult}`);
			assert.ok(withImage > 1000, `an image must not count as zero, got ${withImage}`);
			assert.ok(textOnly < 10, `plain text stays cheap, got ${textOnly}`);
		});

		test("a structured tool result counts its serialized size", () => {
			const structured = estimator.estimateMessageTokens({
				role: vscode.LanguageModelChatMessageRole.User,
				content: [{ callId: "call_1", content: [{ rows: Array.from({ length: 300 }, (_, i) => i) }] }],
			} as unknown as vscode.LanguageModelChatMessage);
			assert.ok(structured > 100, `expected the serialized payload to count, got ${structured}`);
		});

		test("tool schemas and the system prompt contribute", () => {
			assert.equal(estimator.estimateToolTokens(undefined), 0);
			assert.equal(estimator.estimateToolTokens({ tools: [] }), 0);

			const tools = estimator.estimateToolTokens({
				tools: [
					{
						toolSpec: {
							name: "read_file",
							description: "d".repeat(400),
							inputSchema: { json: { type: "object" } },
						},
					},
				],
			});
			assert.ok(tools > 90, `tool schemas must be counted, got ${tools}`);

			assert.equal(estimator.estimateSystemTokens([{ text: "abcd" }, { text: "abcd" }]), 2);
			assert.equal(estimator.estimateSystemTokens([{}]), 0, "a cachePoint block has no text");
		});

		test("plain strings and multi-message totals still work", () => {
			assert.equal(estimator.estimateTokens(model, "abcdefgh"), 2);
			const msg = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("abcd")],
			} as vscode.LanguageModelChatMessage;
			assert.equal(estimator.estimateMessagesTokens([msg, msg]), estimator.estimateMessageTokens(msg) * 2);
		});
	});

	suite("tool-call failure reporting", () => {
		const failures = [{ index: 0, toolUseId: "call_1", name: "replace_string_in_file", argsLength: 42, snippet: "{" }];

		test("names the output-token cap when that is what truncated the call", () => {
			// Before this, the only signal was one log line and an agent that stopped.
			const msg = describeToolCallFailure(failures, "max_tokens", 4096, 32000);
			assert.ok(msg.includes("replace_string_in_file"), "must name the tool");
			assert.ok(msg.includes("4096"), "must state the limit that was hit");
			assert.ok(msg.includes("32000"), "must state what the model allows");
			assert.ok(msg.includes("maxOutputTokens"), "must point at the setting to change");
		});

		test("falls back to a plain malformed-JSON message otherwise", () => {
			const msg = describeToolCallFailure(failures, "end_turn", 32000, 32000);
			assert.ok(msg.includes("not valid JSON"));
			assert.ok(!msg.includes("maxOutputTokens"), "do not blame the cap when it was not hit");
		});

		test("uses the block index when the tool had no name", () => {
			const msg = describeToolCallFailure(
				[{ index: 3, toolUseId: undefined, name: undefined, argsLength: 0, snippet: "" }],
				undefined,
				4096,
				4096
			);
			assert.ok(msg.includes("#3"));
		});
	});

	suite("thinking display", () => {
		teardown(() => resetThinkingPartCache());

		const collect = () => {
			const parts: vscode.LanguageModelResponsePart[] = [];
			return { parts, progress: { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) } };
		};

		test("hidden emits nothing", () => {
			const { parts, progress } = collect();
			const r = createThinkingReporter(progress, "hidden");
			r.delta("secret");
			r.end();
			assert.equal(parts.length, 0);
		});

		test("native stays silent when the proposed API is absent", () => {
			// The manifest cannot declare enabledApiProposals — the Marketplace
			// rejected that release — so reasoning must never leak into the answer.
			resetThinkingPartCache();
			const { parts, progress } = collect();
			const r = createThinkingReporter(progress, "native");
			r.delta("secret");
			r.end();
			if (getThinkingPartCtor() === null) {
				assert.equal(parts.length, 0);
			} else {
				assert.equal(parts.length, 1, "with the API present it should be reported natively");
			}
		});

		test("text wraps reasoning in one collapsed block", () => {
			const { parts, progress } = collect();
			const r = createThinkingReporter(progress, "text");
			r.delta("first ");
			r.delta("second");
			r.end();
			r.end();

			const joined = parts.map((p) => (p as vscode.LanguageModelTextPart).value).join("");
			assert.ok(joined.includes("<details>"), "expected a collapsed wrapper");
			assert.ok(joined.includes("first second"), "expected both deltas");
			assert.equal(joined.split("<details>").length - 1, 1, "wrapper must open exactly once");
			assert.equal(joined.split("</details>").length - 1, 1, "a second end() must not close it twice");
		});
	});

	suite("usage tracking", () => {
		test("accumulates across turns, including cache reads and writes", () => {
			const tracker = new UsageTracker();
			const turn = (over: Partial<Parameters<UsageTracker["record"]>[0]> = {}) => ({
				modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				stopReason: "end_turn",
				usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 80, cacheWriteInputTokens: 5 },
				maxInputTokens: 200000,
				maxOutputTokens: 32000,
				emittedToolCalls: 1,
				cachePoints: 4,
				thinkingEnabled: false,
				...over,
			});

			tracker.record(turn());
			tracker.record(turn());

			assert.deepEqual(tracker.getTotals(), {
				turns: 2,
				inputTokens: 200,
				outputTokens: 40,
				cacheReadInputTokens: 160,
				cacheWriteInputTokens: 10,
			});

			tracker.reset();
			assert.equal(tracker.getTotals().turns, 0);
		});

		test("a turn with no metadata is still counted and does not throw", () => {
			const tracker = new UsageTracker();
			tracker.record({
				modelId: "m",
				maxInputTokens: 0,
				maxOutputTokens: 0,
				emittedToolCalls: 0,
				cachePoints: 0,
				thinkingEnabled: false,
			});
			assert.equal(tracker.getTotals().turns, 1);
			assert.equal(tracker.getTotals().inputTokens, 0);
		});
	});

	suite("stream-processor results", () => {
		const drain = async (events: unknown[], opts: Parameters<StreamProcessor["processStream"]>[3] = {}) => {
			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };
			const stream = (async function* () {
				for (const e of events) { yield e as never; }
			})();
			const result = await new StreamProcessor().processStream(
				stream, progress, new vscode.CancellationTokenSource().token, opts
			);
			return { parts, result };
		};

		test("captures usage, latency and stop reason from the metadata event", () => {
			// Bedrock reports all of this on metadata, which the provider used to ignore.
			return drain([
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hello" } } },
				{ messageStop: { stopReason: "end_turn" } },
				{ metadata: { usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadInputTokens: 7 }, metrics: { latencyMs: 123 } } },
			]).then(({ parts, result }) => {
				assert.equal(result.stopReason, "end_turn");
				assert.equal(result.usage?.inputTokens, 11);
				assert.equal(result.usage?.cacheReadInputTokens, 7);
				assert.equal(result.latencyMs, 123);
				assert.equal(result.textLength, 5);
				assert.equal(parts.length, 1);
			});
		});

		test("streams a tool call and reports it exactly once", async () => {
			const { result, parts } = await drain([
				{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "read_file" } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":' } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"/a.ts"}' } } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				{ messageStop: { stopReason: "tool_use" } },
			]);

			const calls = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
			assert.equal(calls.length, 1, "contentBlockStop then messageStop must not double-emit");
			assert.equal(result.emittedToolCalls, 1);
			assert.deepEqual(result.toolUseIds, ["call_1"]);
			assert.equal(result.toolCallFailures.length, 0);
		});

		test("a truncated tool call is surfaced as a failure, not silence", async () => {
			const { result, parts } = await drain([
				{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "read_file" } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"/a' } } } },
				{ messageStop: { stopReason: "max_tokens" } },
			]);

			assert.equal(parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart).length, 0);
			assert.equal(result.toolCallFailures.length, 1, "the caller needs something to report");
			assert.equal(result.stopReason, "max_tokens");
		});

		test("collects reasoning with its signature for replay", async () => {
			// The signature must come back verbatim next turn or Bedrock rejects it.
			const { result } = await drain([
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "let me think" } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-abc" } } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } },
				{ messageStop: { stopReason: "end_turn" } },
			]);

			assert.equal(result.reasoning.length, 1);
			assert.equal(result.reasoning[0].text, "let me think");
			assert.equal(result.reasoning[0].signature, "sig-abc");
		});

		test("reasoning renders as a collapsed block when display is text", async () => {
			const { parts } = await drain(
				[
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "thinking" } } } },
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
				],
				{ thinkingDisplay: "text" }
			);
			const joined = parts.map((p) => (p as vscode.LanguageModelTextPart).value ?? "").join("");
			assert.ok(joined.includes("<details>") && joined.includes("thinking"));
		});

		test("a mid-stream exception event is raised, not swallowed", async () => {
			// Bedrock reports these as events rather than throwing, so the turn used to
			// end quietly as though the model had simply finished.
			await assert.rejects(
				drain([
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
					{ modelStreamErrorException: { message: "upstream died" } },
				]),
				/ModelStreamErrorException: upstream died/
			);
		});

		test("one malformed event does not abandon the rest of the response", async () => {
			const { result } = await drain([
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "before " } } },
				{ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: null } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "after" } } },
				{ messageStop: { stopReason: "end_turn" } },
			]);
			assert.equal(result.textLength, "before after".length);
			assert.equal(result.stopReason, "end_turn");
		});

		test("a space separates streamed text from a following tool call", async () => {
			const { parts } = await drain([
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "I will read it." } } },
				{ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "read_file" } } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } } },
				{ contentBlockStop: { contentBlockIndex: 1 } },
				{ messageStop: { stopReason: "tool_use" } },
			]);
			const texts = parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
			assert.equal(texts.length, 2);
			assert.equal((texts[1] as vscode.LanguageModelTextPart).value, " ");
		});
	});

	suite("thinking effort variants", () => {
		const SONNET = "us.anthropic.claude-sonnet-4-6-20250929-v1:0";

		test("round-trips an effort level through the model ID", () => {
			for (const effort of THINKING_EFFORTS) {
				const id = encodeVariantId(SONNET, effort);
				assert.deepEqual(decodeVariantId(id), { baseId: SONNET, effort });
			}
		});

		test("leaves a plain model ID untouched", () => {
			assert.deepEqual(decodeVariantId(SONNET), { baseId: SONNET });
		});

		test("an inference profile ARN survives decoding unchanged", () => {
			// ARNs contain colons and slashes; the separator must not collide.
			const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
			assert.deepEqual(decodeVariantId(arn), { baseId: arn });
			assert.deepEqual(decodeVariantId(encodeVariantId(arn, "high")), { baseId: arn, effort: "high" });
		});

		test("an unrecognized suffix degrades to the base model, not an error", () => {
			// A conversation persisted by a newer build must still be invocable.
			assert.deepEqual(decodeVariantId(`${SONNET}#think=extreme`), { baseId: SONNET });
			assert.deepEqual(decodeVariantId(`${SONNET}#think=`), { baseId: SONNET });
		});

		test("a separator with nothing before it is not treated as a variant", () => {
			assert.deepEqual(decodeVariantId("#think=high"), { baseId: "#think=high" });
		});

		test("a picked variant overrides the global default", () => {
			const resolved = resolveThinkingForTurn("xhigh", { enabled: false, effort: "low" });
			assert.deepEqual(resolved, { enabled: true, effort: "xhigh", source: "model-picker" });
		});

		test("a plain model inherits the global default, including off", () => {
			assert.deepEqual(resolveThinkingForTurn(undefined, { enabled: true, effort: "high" }), {
				enabled: true,
				effort: "high",
				source: "default",
			});
			assert.deepEqual(resolveThinkingForTurn(undefined, { enabled: false, effort: "high" }), {
				enabled: false,
				effort: "high",
				source: "default",
			});
		});

		test("the off variant round-trips and is distinguishable from an effort level", () => {
			const id = encodeVariantId(SONNET, OFF_VARIANT);
			assert.equal(id, `${SONNET}#think=off`);
			assert.deepEqual(decodeVariantId(id), { baseId: SONNET, effort: OFF_VARIANT });
			// "off" must not leak into the effort list: it is the absence of a level,
			// not a level, and THINKING_EFFORTS drives budget tables and enums.
			assert.equal(isThinkingEffort(OFF_VARIANT), false);
			assert.ok(!(THINKING_EFFORTS as readonly string[]).includes(OFF_VARIANT));
		});

		test("the off variant suppresses a global default that is on", () => {
			// The whole point of the row: without it the picker could only ever raise
			// reasoning, never turn it off for a single conversation.
			assert.deepEqual(resolveThinkingForTurn(OFF_VARIANT, { enabled: true, effort: "high" }), {
				enabled: false,
				effort: "high",
				source: "model-picker",
			});
			// And is harmless when the default is already off.
			assert.deepEqual(resolveThinkingForTurn(OFF_VARIANT, { enabled: false, effort: "low" }), {
				enabled: false,
				effort: "low",
				source: "model-picker",
			});
		});

		test("an off variant sends no thinking fields and reserves no output tokens", () => {
			const built = buildRequestInput({
				model: { id: SONNET, maxOutputTokens: 128000 },
				converted: { messages: [{ role: "user", content: [{ text: "hi" }] }], system: [] },
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(SONNET),
				maxOutputTokensOverride: 0,
				// What the handler passes after resolving an "off" pick.
				thinking: { enabled: false, effort: "high", budgetTokens: 0 },
			});
			assert.equal(built.thinkingEnabled, false);
			assert.equal(built.input.additionalModelRequestFields, undefined);
			assert.equal(
				built.input.inferenceConfig!.maxTokens,
				128000,
				"with no reasoning there is nothing to reserve output tokens for"
			);
		});

		test("the off row appears only when there is a default for it to override", () => {
			const on = expandEffortVariants(modelInfo(SONNET, "Claude Sonnet 4.6"), {
				thinkingEnabledByDefault: true,
			});
			assert.equal(on.length, 2 + THINKING_EFFORTS.length, "plain + off + one per level");
			assert.equal(on[0].id, SONNET, "the plain entry still comes first");
			assert.equal(
				decodeVariantId(on[1].id).effort,
				OFF_VARIANT,
				"off leads the variants, mirroring the status-bar quick pick"
			);
			assert.equal(on[1].name, "Claude Sonnet 4.6 · think off");
			assert.deepEqual(
				on.slice(2).map((v) => decodeVariantId(v.id).effort),
				[...THINKING_EFFORTS],
				"effort levels follow in ascending order"
			);

			// With the default already off, the plain row does the same job, so
			// offering both would imply a distinction that does not exist.
			const off = expandEffortVariants(modelInfo(SONNET, "Claude Sonnet 4.6"), {
				thinkingEnabledByDefault: false,
			});
			assert.equal(off.length, 1 + THINKING_EFFORTS.length);
			assert.ok(
				off.every((v) => decodeVariantId(v.id).effort !== OFF_VARIANT),
				"no off row when the default is off"
			);

			// Omitting the option must not add the row either, so a caller that has
			// not been updated cannot accidentally show it.
			assert.equal(expandEffortVariants(modelInfo(SONNET, "Claude Sonnet 4.6")).length, 1 + THINKING_EFFORTS.length);
		});

		test("a model with no reasoning mode gets no off row either", () => {
			const expanded = expandEffortVariants(modelInfo("amazon.nova-pro-v1:0", "Nova Pro"), {
				thinkingEnabledByDefault: true,
			});
			assert.equal(expanded.length, 1, "an off switch for a model that never reasons is noise");
		});

		test("expansion adds one entry per effort level for a reasoning model", () => {
			const variants = expandEffortVariants(modelInfo(SONNET, "Claude Sonnet 4.6"));

			assert.equal(variants.length, 1 + THINKING_EFFORTS.length);
			assert.equal(variants[0].id, SONNET, "the plain entry comes first and keeps the bare ID");
			assert.deepEqual(
				variants.slice(1).map((v) => decodeVariantId(v.id).effort),
				[...THINKING_EFFORTS]
			);
			// Every row must be distinguishable by name alone: `detail` is not
			// rendered in all the places VS Code shows a model.
			assert.equal(new Set(variants.map((v) => v.name)).size, variants.length);
			for (const v of variants.slice(1)) {
				assert.ok(v.name.startsWith("Claude Sonnet 4.6 · think "), `unexpected name: ${v.name}`);
			}
		});

		test("expansion carries capabilities and limits through unchanged", () => {
			const base = modelInfo(SONNET, "Claude Sonnet 4.6");
			for (const v of expandEffortVariants(base)) {
				assert.equal(v.maxInputTokens, base.maxInputTokens);
				assert.equal(v.maxOutputTokens, base.maxOutputTokens);
				assert.deepEqual(v.capabilities, base.capabilities);
				assert.equal(v.family, base.family);
			}
		});

		test("a model with no reasoning mode gets no variants", () => {
			for (const id of ["amazon.nova-pro-v1:0", "meta.llama3-2-11b-instruct-v1:0", "anthropic.claude-v2"]) {
				const expanded = expandEffortVariants(modelInfo(id, id));
				assert.equal(expanded.length, 1, `${id} should not be expanded`);
				assert.equal(expanded[0].id, id);
			}
		});

		test("a variant ID resolves to the same model profile as its base", () => {
			// Guards the decode step in the request handler: were it skipped, the
			// profile lookup would still have to be right, and this asserts what the
			// handler relies on.
			const base = getModelProfile(SONNET);
			const viaVariant = getModelProfile(decodeVariantId(encodeVariantId(SONNET, "high")).baseId);
			assert.deepEqual(viaVariant, base);
		});
	});
});

/** Minimal LanguageModelChatInformation for the variant-expansion tests. */
function modelInfo(id: string, name: string): vscode.LanguageModelChatInformation {
	return {
		id,
		name,
		tooltip: "AWS Bedrock - Anthropic",
		detail: "Anthropic • us-east-1",
		family: "bedrock",
		version: "1.0.0",
		maxInputTokens: 200000,
		maxOutputTokens: 32000,
		capabilities: { toolCalling: true, imageInput: true },
	};
}
