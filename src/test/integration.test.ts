import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { BedrockChatProvider } from "../providers/bedrock-chat.provider";
import { ConfigurationService } from "../services/configuration.service";
import { AuthenticationService } from "../services/authentication.service";

/**
 * Load API key from .env file
 */
function loadApiKeyFromEnv(): string | undefined {
	const envPath = path.resolve(__dirname, "../../.env");
	if (!fs.existsSync(envPath)) {
		return undefined;
	}

	const envContent = fs.readFileSync(envPath, 'utf-8');
	const lines = envContent.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
			const [key, ...valueParts] = trimmed.split('=');
			if (key.trim() === 'AWS_BEARER_TOKEN_BEDROCK' && valueParts.length > 0) {
				return valueParts.join('=').trim();
			}
		}
	}
	return undefined;
}

/**
 * Simple integration test that verifies Bedrock API works end-to-end.
 * Run with: npm test (automatically loads .env file)
 */
suite("Bedrock Integration", () => {
	// Each test below replaces vscode.workspace.getConfiguration with a mock. Restore it
	// after every test so a failure mid-test can't leak its mock into later tests
	// (cross-test contamination). Captured before each test mocks it.
	let suiteOriginalGetConfiguration: typeof vscode.workspace.getConfiguration;
	setup(() => { suiteOriginalGetConfiguration = vscode.workspace.getConfiguration; });
	teardown(() => { (vscode.workspace as any).getConfiguration = suiteOriginalGetConfiguration; });

	test("End-to-end: list models, send message, get streaming response", async function () {
		console.log("  → Loading API key from .env...");
		const apiKey = loadApiKeyFromEnv();
		if (!apiKey) {
			console.log("⚠️  Skipping integration test - set AWS_BEARER_TOKEN_BEDROCK to run");
			this.skip();
			return;
		}

		this.timeout(30000);

		// Mock VS Code configuration to use API key from environment
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'languageModelChatProvider.bedrock') {
				return {
					get: (key: string) => {
						if (key === 'region') return 'eu-central-1';
						if (key === 'authMethod') return 'api-key';
						if (key === 'apiKey') return apiKey;
						return undefined;
					},
					has: () => true,
					inspect: () => undefined,
					update: async () => {}
				};
			}
			return originalGetConfiguration(section);
		};

		const configService = new ConfigurationService();
		const authService = new AuthenticationService(configService);
		const provider = new BedrockChatProvider(configService, authService);

		// Step 1: Fetch models
		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(models.length > 0, "Should fetch models from Bedrock");
		console.log(`  ✓ Found ${models.length} models`);

		// Step 2: Find Claude Haiku 4.5 by name (how users actually select models)
		const claude = models.find((m) => m.name.includes("Claude Haiku 4.5"));

		assert.ok(claude, "Should have Claude Haiku 4.5 available");

		console.log(`  ✓ Using model: ${claude.name}`);
		console.log(`  ✓ System selected: ${claude.id}`);

		// Step 3: Send message and verify streaming response
		console.log("  → Sending test message...");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Reply with exactly: TEST_PASS")],
				name: undefined,
			},
		];

		let receivedText = "";
		let chunkCount = 0;

		await provider.provideLanguageModelChatResponse(
			claude!,
			messages,
			{} as vscode.LanguageModelChatRequestHandleOptions,
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						receivedText += part.value;
						chunkCount++;
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		// Verify streaming worked
		assert.ok(chunkCount > 0, "Should receive streaming chunks");
		assert.ok(receivedText.length > 0, "Should receive response text");
		console.log(`  ✓ Received ${chunkCount} chunks, ${receivedText.length} chars`);
		console.log(`  ✓ Response: "${receivedText.trim()}"`);

		// Verify response quality
		assert.ok(
			receivedText.includes("TEST_PASS") || receivedText.includes("test") || receivedText.length > 3,
			"Response should be meaningful"
		);
		console.log("  ✓ Integration test PASSED");
	});

	test("Claude 4.x: temperature + top_p together is accepted (temperature omitted by profile)", async function () {
		// Regression guard for PR #9. Bedrock rejects requests to Claude 4.x models that
		// specify BOTH temperature and top_p (Sonnet/Haiku 4.5) — and rejects temperature
		// entirely for some Opus 4.x. getModelProfile() now flags supportsTemperature=false
		// for Claude 4.x so the handler omits temperature, leaving only top_p.
		// Before the fix this request throws a Bedrock ValidationException.
		const apiKey = loadApiKeyFromEnv();
		if (!apiKey) {
			console.log("⚠️  Skipping integration test - set AWS_BEARER_TOKEN_BEDROCK to run");
			this.skip();
			return;
		}

		this.timeout(30000);

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'languageModelChatProvider.bedrock') {
				return {
					get: (key: string) => {
						if (key === 'region') return 'eu-central-1';
						if (key === 'authMethod') return 'api-key';
						if (key === 'apiKey') return apiKey;
						return undefined;
					},
					has: () => true,
					inspect: () => undefined,
					update: async () => {}
				};
			}
			return originalGetConfiguration(section);
		};

		const configService = new ConfigurationService();
		const authService = new AuthenticationService(configService);
		const provider = new BedrockChatProvider(configService, authService);

		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		// Prefer Sonnet 4.5; fall back to any Claude 4.x the key can reach.
		const claude4 =
			models.find((m) => m.name.includes("Claude Sonnet 4.5")) ??
			models.find((m) => /Claude (Sonnet|Opus|Haiku) 4/.test(m.name));
		assert.ok(claude4, "Should have a Claude 4.x model available to exercise the temperature path");
		console.log(`  ✓ Using model: ${claude4.name} (${claude4.id})`);

		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Reply with exactly: TEMP_OK")],
				name: undefined,
			},
		];

		let receivedText = "";
		let chunkCount = 0;

		// Pass BOTH temperature and top_p — the combination Bedrock rejects for Claude 4.x
		// unless temperature is dropped. This is what reproduces the bug pre-fix.
		const options = { modelOptions: { temperature: 0.7, top_p: 0.9 } } as unknown as vscode.LanguageModelChatRequestHandleOptions;

		await provider.provideLanguageModelChatResponse(
			claude4,
			messages,
			options,
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						receivedText += part.value;
						chunkCount++;
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		assert.ok(chunkCount > 0, "Should receive streaming chunks (no ValidationException)");
		assert.ok(receivedText.length > 0, "Should receive response text");
		console.log(`  ✓ Received ${chunkCount} chunks: "${receivedText.trim()}"`);
		console.log("  ✓ temperature+top_p accepted — PR #9 fix verified");
	});

	test("Tool calling: model calls calculator tool", async function () {
		const apiKey = loadApiKeyFromEnv();
		if (!apiKey) {
			console.log("⚠️  Skipping integration test - set AWS_BEARER_TOKEN_BEDROCK to run");
			this.skip();
			return;
		}

		this.timeout(30000);

		// Mock VS Code configuration to use API key from environment
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'languageModelChatProvider.bedrock') {
				return {
					get: (key: string) => {
						if (key === 'region') return 'eu-central-1';
						if (key === 'authMethod') return 'api-key';
						if (key === 'apiKey') return apiKey;
						return undefined;
					},
					has: () => true,
					inspect: () => undefined,
					update: async () => {}
				};
			}
			return originalGetConfiguration(section);
		};

		const configService = new ConfigurationService();
		const authService = new AuthenticationService(configService);
		const provider = new BedrockChatProvider(configService, authService);

		// Step 1: Fetch models
		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		// Step 2: Find Claude Haiku 4.5 by name (how users actually select models)
		const claude = models.find((m: any) => m.name.includes("Claude Haiku 4.5"));

		assert.ok(claude, "Should have Claude Haiku 4.5 available");

		console.log(`  ✓ Using model: ${claude.name}`);
		console.log(`  ✓ System selected: ${claude.id}`);

		// Step 3: Define a calculator tool
		const tools: vscode.LanguageModelChatTool[] = [
			{
				name: "calculate",
				description: "Performs basic arithmetic operations",
				inputSchema: {
					type: "object",
					properties: {
						operation: {
							type: "string",
							enum: ["add", "subtract", "multiply", "divide"],
							description: "The arithmetic operation to perform"
						},
						a: {
							type: "number",
							description: "First number"
						},
						b: {
							type: "number",
							description: "Second number"
						}
					},
					required: ["operation", "a", "b"],
					additionalProperties: false
				}
			}
		];

		// Step 3: Send message that requires tool use
		console.log("  → Sending message that requires tool...");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("What is 15 plus 27? Use the calculator tool to compute this.")],
				name: undefined,
			},
		];

		const receivedParts: vscode.LanguageModelTextPart[] = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];

		await provider.provideLanguageModelChatResponse(
			claude,
			messages,
			{ tools },
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						receivedParts.push(part);
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						toolCalls.push(part);
						console.log(`  ✓ Tool call received: ${part.name}`);
						console.log(`    Call ID: ${part.callId}`);
						console.log(`    Input:`, part.input);
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		// Step 4: Verify tool was called
		assert.ok(toolCalls.length > 0, "Should receive at least one tool call");

		const toolCall = toolCalls[0]!;
		assert.equal(toolCall.name, "calculate", "Tool name should be 'calculate'");
		assert.ok(toolCall.callId, "Tool call should have an ID");

		// Verify input parameters
		const input = toolCall.input as { operation: string; a: number; b: number };
		assert.equal(input.operation, "add", "Operation should be 'add'");
		assert.equal(input.a, 15, "First number should be 15");
		assert.equal(input.b, 27, "Second number should be 27");

		// Step 5: Execute the tool
		console.log("  → Executing tool...");
		let result: number;
		switch (input.operation) {
			case "add":
				result = input.a + input.b;
				break;
			case "subtract":
				result = input.a - input.b;
				break;
			case "multiply":
				result = input.a * input.b;
				break;
			case "divide":
				result = input.a / input.b;
				break;
			default:
				throw new Error(`Unknown operation: ${input.operation}`);
		}
		console.log(`  ✓ Calculated: ${input.a} ${input.operation} ${input.b} = ${result}`);
		assert.equal(result, 42, "Result should be 42");

		// Step 6: Send result back to LLM
		console.log("  → Sending result back to LLM...");
		const followUpMessages: vscode.LanguageModelChatMessage[] = [
			...messages,
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [toolCall],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelToolResultPart(
						toolCall.callId,
						[new vscode.LanguageModelTextPart(result.toString())]
					)
				],
				name: undefined,
			},
		];

		let finalResponse = "";
		await provider.provideLanguageModelChatResponse(
			claude,
			followUpMessages,
			{ tools },
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						finalResponse += part.value;
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		console.log(`  ✓ Final response: "${finalResponse.trim()}"`);

		// Step 7: Verify the complete round trip
		assert.ok(finalResponse.length > 0, "Should receive final response");
		assert.ok(
			finalResponse.includes("42") || finalResponse.includes("forty-two") || finalResponse.includes("forty two"),
			"Response should mention the correct answer (42)"
		);

		console.log("  ✓ Tool calling integration test PASSED");
	});

	test("Vision: image with a wrong mimeType is accepted (magic-byte detection)", async function () {
		// Regression guard for PR #20. VS Code's browser attachment can report an
		// incorrect mimeType — e.g. image/jpeg for data that is actually PNG. Before the
		// fix, convertMessages trusted the mimeType and sent format:"jpeg" with PNG bytes,
		// which Bedrock rejects: "The image was specified using the image/jpeg media type,
		// but the image appears to be a image/png image". detectImageFormat now derives the
		// real format from the magic bytes, so the request is accepted.
		const apiKey = loadApiKeyFromEnv();
		if (!apiKey) {
			console.log("⚠️  Skipping integration test - set AWS_BEARER_TOKEN_BEDROCK to run");
			this.skip();
			return;
		}

		this.timeout(30000);

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'languageModelChatProvider.bedrock') {
				return {
					get: (key: string) => {
						if (key === 'region') return 'eu-central-1';
						if (key === 'authMethod') return 'api-key';
						if (key === 'apiKey') return apiKey;
						return undefined;
					},
					has: () => true,
					inspect: () => undefined,
					update: async () => {}
				};
			}
			return originalGetConfiguration(section);
		};

		const configService = new ConfigurationService();
		const authService = new AuthenticationService(configService);
		const provider = new BedrockChatProvider(configService, authService);

		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		const claude = models.find((m) => m.name.includes("Claude Haiku 4.5"));
		assert.ok(claude, "Should have Claude Haiku 4.5 (vision-capable) available");
		console.log(`  ✓ Using model: ${claude.name}`);

		// A valid 1x1 PNG. The bytes begin with the PNG signature (89 50 4E 47 ...),
		// but we deliberately attach it with mimeType image/jpeg to reproduce the bug.
		const PNG_1x1_BASE64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const pngBytes = new Uint8Array(Buffer.from(PNG_1x1_BASE64, "base64"));
		assert.equal(pngBytes[0], 0x89, "fixture must actually be PNG data");

		const messages = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("Reply with exactly: IMAGE_OK"),
					{ mimeType: "image/jpeg", data: pngBytes },
				],
				name: undefined,
			},
		] as unknown as vscode.LanguageModelChatMessage[];

		let receivedText = "";
		let chunkCount = 0;

		console.log("  → Sending PNG bytes declared as image/jpeg...");
		await provider.provideLanguageModelChatResponse(
			claude,
			messages,
			{} as vscode.LanguageModelChatRequestHandleOptions,
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						receivedText += part.value;
						chunkCount++;
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		assert.ok(chunkCount > 0, "Should receive streaming chunks (no ValidationException)");
		assert.ok(receivedText.length > 0, "Should receive response text");
		console.log(`  ✓ Received ${chunkCount} chunks: "${receivedText.trim()}"`);
		console.log("  ✓ Mislabeled image accepted — PR #20 fix verified");
	});
});
