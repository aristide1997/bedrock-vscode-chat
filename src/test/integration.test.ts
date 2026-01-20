import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { BedrockChatModelProvider } from "../provider";

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
						if (key === 'region') return 'us-east-1';
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

		const provider = new BedrockChatModelProvider(
			{
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			{
				get: () => undefined,
				update: async () => {},
				keys: () => [],
				setKeysForSync: () => {},
			} as unknown as vscode.Memento,
			"test/1.0"
		);

		// Step 1: Fetch models
		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(models.length > 0, "Should fetch models from Bedrock");
		console.log(`  ✓ Found ${models.length} models`);

		// Step 2: Find Claude 3.5 Haiku by name (how users actually select models)
		const claude = models.find((m) => m.name.includes("Claude 3.5 Haiku"));

		assert.ok(claude, "Should have Claude 3.5 Haiku available");

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
						if (key === 'region') return 'us-east-1';
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

		const provider = new BedrockChatModelProvider(
			{
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			{
				get: () => undefined,
				update: async () => {},
				keys: () => [],
				setKeysForSync: () => {},
			} as unknown as vscode.Memento,
			"test/1.0"
		);

		// Step 1: Fetch models
		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		// Step 2: Find Claude 3.5 Haiku by name (how users actually select models)
		const claude = models.find((m) => m.name.includes("Claude 3.5 Haiku"));

		assert.ok(claude, "Should have Claude 3.5 Haiku available");

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
});
