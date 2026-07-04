import * as assert from "assert";
import * as vscode from "vscode";
import { BedrockChatProvider } from "../providers/bedrock-chat.provider";
import { ConfigurationService } from "../services/configuration.service";
import { AuthenticationService } from "../services/authentication.service";
import { convertMessages, detectImageFormat } from "../converters/messages";
import { convertTools } from "../converters/tools";
import { validateRequest, validateTools } from "../validation";
import { tryParseJSONObject } from "../converters/schema";
import { ToolCallBufferManager } from "../tool-buffer";
import { getProxyAgent } from "../clients/bedrock.client";
import { getModelProfile } from "../profiles";
import { buildRequestInput } from "../converters/request";
import { StreamProcessor } from "../stream-processor";
import { resolveInvocationTarget, regionGeoPrefix } from "../services/model.service";

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
	const hasToolUse = result.messages.some((m: any) => m.content.some((c: any) => "toolUse" in c));
	const hasToolResult = result.messages.some((m: any) => m.content.some((c: any) => "toolResult" in c));
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
			assert.equal(result.messages.length, 1);
			assert.equal(result.messages[0].role, "assistant");
			assert.ok(result.messages[0].content.length > 0);
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
			assert.ok(Array.isArray(out.tools) && out.tools[0].toolSpec);
			assert.equal(out.tools[0].toolSpec.name, "do_something");
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
		test("Claude 4.x models omit temperature (supportsTemperature === false)", () => {
			// Bedrock rejects the temperature inference parameter for Claude 4+ models.
			const claude4Ids = [
				"anthropic.claude-sonnet-4-5-20250929-v1:0",
				"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
				"anthropic.claude-opus-4-7-20250805-v1:0",
				"anthropic.claude-opus-4-20250514-v1:0",
				"anthropic.claude-haiku-4-5-20251001-v1:0",
			];
			for (const id of claude4Ids) {
				assert.equal(getModelProfile(id).supportsTemperature, false, `expected supportsTemperature=false for ${id}`);
			}
		});

		test("Claude 3.x and non-Claude models keep temperature (supportsTemperature === true)", () => {
			const keepTemperatureIds = [
				"anthropic.claude-3-5-sonnet-20241022-v2:0",
				"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
				"anthropic.claude-3-haiku-20240307-v1:0",
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
			const matrix: [string, { supportsToolChoice: boolean; toolResultFormat: 'text' | 'json'; supportsTemperature: boolean }][] = [
				// anthropic: tool choice + text results; temperature only for pre-4.x
				["anthropic.claude-3-5-sonnet-20241022-v2:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true }],
				["us.anthropic.claude-3-5-sonnet-20241022-v2:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true }],
				["anthropic.claude-sonnet-4-5-20250929-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false }],
				["eu.anthropic.claude-sonnet-4-5-20250929-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: false }],
				// mistral: NO tool choice + JSON tool-result format
				["mistral.mistral-large-2407-v1:0", { supportsToolChoice: false, toolResultFormat: 'json', supportsTemperature: true }],
				["us.mistral.pixtral-large-2502-v1:0", { supportsToolChoice: false, toolResultFormat: 'json', supportsTemperature: true }],
				// amazon nova: tool choice + text; non-nova amazon falls back to default (no tool choice)
				["amazon.nova-pro-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true }],
				["us.amazon.nova-lite-v1:0", { supportsToolChoice: true, toolResultFormat: 'text', supportsTemperature: true }],
				["amazon.titan-text-express-v1", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true }],
				// cohere / meta / ai21: default profile
				["cohere.command-r-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true }],
				["meta.llama3-70b-instruct-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true }],
				["ai21.jamba-1-5-large-v1:0", { supportsToolChoice: false, toolResultFormat: 'text', supportsTemperature: true }],
			];
			for (const [id, expected] of matrix) {
				assert.deepEqual(getModelProfile(id), expected, `profile mismatch for ${id}`);
			}
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

		test("content-based deduplication - prevents duplicate emissions", async () => {
			const buffer = new ToolCallBufferManager();
			const emitted: vscode.LanguageModelResponsePart[] = [];
			const progress = {
				report: (part: vscode.LanguageModelResponsePart) => emitted.push(part),
			};

			buffer.startToolCall(0, "call_1", "search");
			buffer.appendArgs(0, '{"query":"test"}');
			await buffer.tryEmit(0, progress);
			assert.equal(emitted.length, 1);

			buffer.startToolCall(1, "call_2", "search");
			buffer.appendArgs(1, '{"query":"test"}');
			await buffer.tryEmit(1, progress);
			assert.equal(emitted.length, 1);

			buffer.startToolCall(2, "call_3", "search");
			buffer.appendArgs(2, '{"query":"different"}');
			await buffer.tryEmit(2, progress);
			assert.equal(emitted.length, 2);
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
			assert.equal((agent as any).proxy.href, "http://proxy.example.com:8080/");
		});

		test("getProxyAgent honors lowercase http_proxy", () => {
			process.env.http_proxy = "http://other.example.com:3128";
			assert.ok(getProxyAgent(), "expected a proxy agent from http_proxy");
		});
	});

	suite("converters/request", () => {
		const baseConverted = { messages: [{ role: "user", content: [{ text: "hi" }] }], system: [] as unknown[] };
		const model = { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", maxOutputTokens: 4096 };

		test("omits temperature for Claude 4.x, includes it for 3.x", () => {
			const claude4 = buildRequestInput({
				model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 4096 },
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile("anthropic.claude-sonnet-4-5-20250929-v1:0"),
				toolConfig: undefined,
			});
			assert.equal(claude4.inferenceConfig!.temperature, undefined, "Claude 4.x must omit temperature");

			const claude35 = buildRequestInput({
				model,
				converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id),
				toolConfig: undefined,
			});
			assert.equal(claude35.inferenceConfig!.temperature, 0.7, "Claude 3.x defaults temperature to 0.7");
		});

		test("assembles topP and stopSequences (string and array) from modelOptions", () => {
			const withTopP = buildRequestInput({
				model, converted: baseConverted,
				options: { modelOptions: { top_p: 0.9, stop: "STOP" } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			});
			assert.equal(withTopP.inferenceConfig!.topP, 0.9);
			assert.deepEqual(withTopP.inferenceConfig!.stopSequences, ["STOP"]);

			const withStopArray = buildRequestInput({
				model, converted: baseConverted,
				options: { modelOptions: { stop: ["A", "B"] } } as unknown as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			});
			assert.deepEqual(withStopArray.inferenceConfig!.stopSequences, ["A", "B"]);
			assert.equal(withStopArray.inferenceConfig!.topP, undefined, "no topP when not provided");
		});

		test("includes system + toolConfig only when present", () => {
			const withSystem = buildRequestInput({
				model, converted: { messages: baseConverted.messages, system: [{ text: "be terse" }] },
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: { tools: [] },
			});
			assert.ok(withSystem.system, "system set when system blocks exist");
			assert.ok(withSystem.toolConfig, "toolConfig set when provided");

			const noExtras = buildRequestInput({
				model, converted: baseConverted,
				options: {} as vscode.LanguageModelChatRequestHandleOptions,
				profile: getModelProfile(model.id), toolConfig: undefined,
			});
			assert.equal(noExtras.system, undefined);
			assert.equal(noExtras.toolConfig, undefined);
		});
	});

	suite("stream-processor cancellation", () => {
		const throwingStream = (async function* () { throw new Error("stream broke"); })();
		const progress = { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

		test("suppresses stream error when cancellation was requested", async () => {
			const cts = new vscode.CancellationTokenSource();
			cts.cancel();
			const sp = new StreamProcessor();
			await assert.doesNotReject(
				sp.processStream((async function* () { throw new Error("stream broke"); })(), progress, cts.token),
				"error during cancellation must be suppressed"
			);
		});

		test("rethrows stream error when not cancelled", async () => {
			const cts = new vscode.CancellationTokenSource();
			const sp = new StreamProcessor();
			await assert.rejects(
				sp.processStream(throwingStream, progress, cts.token),
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
		teardown(() => { (vscode.workspace as any).getConfiguration = originalGetConfiguration; });

		const mockConfig = () => {
			(vscode.workspace as any).getConfiguration = (section?: string) => {
				if (section === 'languageModelChatProvider.bedrock') {
					return {
						get: (key: string) => key === 'region' ? 'us-east-1' : key === 'authMethod' ? 'api-key' : key === 'apiKey' ? 'bedrock-api-key-test' : undefined,
						has: () => true, inspect: () => undefined, update: async () => {},
					};
				}
				return originalGetConfiguration(section);
			};
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
			out.messages.flatMap((m: any) => m.content).find((c: any) => c && "toolResult" in c)?.toolResult?.content;

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

	suite("configuration: inference profile overrides", () => {
		let original: typeof vscode.workspace.getConfiguration;
		setup(() => { original = vscode.workspace.getConfiguration; });
		teardown(() => { (vscode.workspace as any).getConfiguration = original; });

		test("defaults to an empty map when unset", () => {
			(vscode.workspace as any).getConfiguration = () => ({ get: () => undefined });
			assert.deepEqual(new ConfigurationService().getInferenceProfileOverrides(), {});
		});

		test("returns the configured map verbatim", () => {
			const map = { "anthropic.claude-haiku-4-5-20251001-v1:0": "arn:aws:bedrock:ap-southeast-2:123456789012:application-inference-profile/abc123" };
			(vscode.workspace as any).getConfiguration = () => ({ get: (k: string) => k === "inferenceProfileOverrides" ? map : undefined });
			assert.deepEqual(new ConfigurationService().getInferenceProfileOverrides(), map);
		});
	});
});
