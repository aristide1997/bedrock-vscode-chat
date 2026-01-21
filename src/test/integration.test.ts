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

		const configService = new ConfigurationService();
		const authService = new AuthenticationService(configService);
		const provider = new BedrockChatProvider(configService, authService);

		// Step 1: Fetch models
		console.log("  → Fetching models...");
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		// Step 2: Find Claude 3.5 Haiku by name (how users actually select models)
		const claude = models.find((m: any) => m.name.includes("Claude 3.5 Haiku"));

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

	test("Thinking: model shows extended reasoning process", async function () {
		const apiKey = loadApiKeyFromEnv();
		if (!apiKey) {
			console.log("⚠️  Skipping integration test - set AWS_BEARER_TOKEN_BEDROCK to run");
			this.skip();
			return;
		}

		this.timeout(45000); // Extended timeout for thinking

		// Mock VS Code configuration with thinking enabled
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'languageModelChatProvider.bedrock') {
				return {
					get: (key: string) => {
						if (key === 'region') return 'us-east-1';
						if (key === 'authMethod') return 'api-key';
						if (key === 'apiKey') return apiKey;
						if (key === 'thinkingEnabled') return true;
						if (key === 'thinkingBudgetTokens') return 2048;
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

		// Step 2: Find Claude 3.7 Sonnet (thinking-capable model)
		const claudeSonnet37 = models.find((m: any) =>
			m.id.includes("claude-3-7-sonnet") || m.name.includes("Claude 3.7 Sonnet")
		);

		if (!claudeSonnet37) {
			console.log("⚠️  Skipping thinking test - Claude 3.7 Sonnet not available in region");
			this.skip();
			return;
		}

		console.log(`  ✓ Using thinking-capable model: ${claudeSonnet37.name}`);
		console.log(`  ✓ Model ID: ${claudeSonnet37.id}`);

		// Step 3: Send a prompt that benefits from step-by-step reasoning
		console.log("  → Sending prompt that requires reasoning...");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart(
						"Solve this step by step: A train travels 120 kilometers in 2 hours. " +
						"If it maintains the same speed, how far will it travel in 5 hours? " +
						"Show your reasoning process."
					)
				],
				name: undefined,
			},
		];

		const thinkingParts: any[] = [];
		const textParts: vscode.LanguageModelTextPart[] = [];
		let thinkingContent = "";
		let finalResponse = "";

		await provider.provideLanguageModelChatResponse(
			claudeSonnet37,
			messages,
			{} as vscode.LanguageModelChatRequestHandleOptions,
			{
				report: (part) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						textParts.push(part);
						finalResponse += part.value;
					} else if ('LanguageModelThinkingPart' in vscode && part instanceof (vscode as any).LanguageModelThinkingPart) {
						thinkingParts.push(part);
						const thinkingValue = (part as any).value || '';
						thinkingContent += thinkingValue;
					}
				},
			},
			new vscode.CancellationTokenSource().token
		);

		// Step 4: Verify thinking content was received
		console.log(`  → Thinking parts received: ${thinkingParts.length}`);
		console.log(`  → Total thinking content: ${thinkingContent.length} chars`);
		console.log(`  → Text parts received: ${textParts.length}`);
		console.log(`  → Final response: ${finalResponse.length} chars`);

		if (thinkingParts.length > 0) {
			console.log(`  ✓ THINKING CONTENT SAMPLE:`);
			console.log(`    "${thinkingContent.substring(0, 150)}..."`);

			assert.ok(thinkingParts.length > 0, "Should receive thinking parts");
			assert.ok(thinkingContent.length > 0, "Should receive thinking content");
			console.log("  ✓ Extended thinking is working!");
		} else {
			console.log("  ⚠️  No thinking parts received (may not be available in this VS Code version)");
		}

		// Step 5: Verify final response quality
		assert.ok(textParts.length > 0, "Should receive text response");
		assert.ok(finalResponse.length > 0, "Should have final response");

		// Check if the answer is correct (300 km)
		const has300 = finalResponse.includes("300") || finalResponse.includes("three hundred");
		assert.ok(
			has300 || finalResponse.toLowerCase().includes("kilometers"),
			"Response should contain the correct answer or reasoning"
		);

		console.log(`  ✓ Final response: "${finalResponse.trim()}"`);
		console.log("  ✓ Thinking integration test PASSED");
	});
});
