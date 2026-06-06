import * as assert from "assert";
import * as vscode from "vscode";
import { BedrockChatProvider } from "../providers/bedrock-chat.provider";
import { ConfigurationService } from "../services/configuration.service";
import { AuthenticationService } from "../services/authentication.service";
import { convertMessages } from "../converters/messages";
import { convertTools } from "../converters/tools";
import { validateRequest, validateTools } from "../validation";
import { tryParseJSONObject } from "../converters/schema";
import { ToolCallBufferManager } from "../tool-buffer";
import { getProxyAgent } from "../clients/bedrock.client";
import { getModelProfile } from "../profiles";

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
});
