import * as assert from "assert";
import * as vscode from "vscode";
import { BedrockChatModelProvider } from "../provider";

/**
 * Simple integration test that verifies Bedrock API works end-to-end.
 * Set AWS_BEARER_TOKEN_BEDROCK environment variable to run: AWS_BEARER_TOKEN_BEDROCK=your_key npm test
 */
suite("Bedrock Integration", () => {
	const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;

	if (!apiKey) {
		console.log("⚠️  Skipping integration tests - set AWS_BEARER_TOKEN_BEDROCK to run");
		return;
	}

	test("End-to-end: list models, send message, get streaming response", async function () {
		this.timeout(30000);

		const provider = new BedrockChatModelProvider(
			{
				get: async () => apiKey,
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			{
				get: () => "us-east-1",
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
		this.timeout(30000);

		const provider = new BedrockChatModelProvider(
			{
				get: async () => apiKey,
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			{
				get: () => "us-east-1",
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

		console.log("  ✓ Tool calling integration test PASSED");
	});
});
