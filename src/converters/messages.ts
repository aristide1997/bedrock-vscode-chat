import * as vscode from "vscode";
import type {
	BedrockMessage,
	BedrockContentBlock,
	BedrockTextBlock,
	BedrockToolUseBlock,
	BedrockToolResultBlock,
	BedrockSystemBlock,
} from "../types";
import { logger } from "../logger";
import { getModelProfile } from "../profiles";

function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		}
	}
	return text;
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelId: string
): {
	messages: BedrockMessage[];
	system: BedrockSystemBlock[];
} {
	const bedrockMessages: BedrockMessage[] = [];
	const systemBlocks: BedrockSystemBlock[] = [];
	const profile = getModelProfile(modelId);

	let pendingToolResults: BedrockToolResultBlock[] = [];

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		const textParts: string[] = [];
		const toolCalls: BedrockToolUseBlock[] = [];
		const toolResults: BedrockToolResultBlock[] = [];

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (m.role === vscode.LanguageModelChatMessageRole.User ||
					m.role === vscode.LanguageModelChatMessageRole.Assistant) {
					textParts.push(part.value);
				} else {
					systemBlocks.push({ text: part.value });
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					toolUse: {
						toolUseId: part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					},
				});
			} else if (isToolResultPart(part)) {
				const resultPart = part as { callId?: string; content?: ReadonlyArray<unknown> };
				const resultText = collectToolResultText(resultPart);
				logger.log("[Message Converter] Tool result text length:", resultText.length, "for ID:", resultPart.callId);

				let content: Array<{ text: string } | { json: Record<string, unknown> }>;
				if (profile.toolResultFormat === 'json') {
					try {
						const parsed = JSON.parse(resultText);
						content = [{ json: parsed }];
					} catch {
						logger.error("[Message Converter] Failed to parse tool result as JSON, using text format");
						content = [{ text: resultText }];
					}
				} else {
					content = [{ text: resultText }];
				}

				toolResults.push({
					toolResult: {
						toolUseId: resultPart.callId ?? "",
						content,
					},
				});
			}
		}

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0 && m.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const content: BedrockContentBlock[] = [];
			const combinedText = textParts.join("");
			if (combinedText) {
				content.push({ text: combinedText });
			}
			content.push(...toolCalls);
			bedrockMessages.push({ role: "assistant", content });
			emittedAssistantToolCall = true;
		}

		if (toolResults.length > 0) {
			pendingToolResults.push(...toolResults);

			const nextMessage = i + 1 < messages.length ? messages[i + 1] : undefined;
			const nextIsToolResultOnly = nextMessage &&
				nextMessage.role === vscode.LanguageModelChatMessageRole.User &&
				nextMessage.content.every(p => isToolResultPart(p));

			if (!nextIsToolResultOnly && pendingToolResults.length > 0) {
				bedrockMessages.push({ role: "user", content: pendingToolResults });
				pendingToolResults = [];
			}
		}

		const text = textParts.join("");
		if (text && !emittedAssistantToolCall && toolResults.length === 0) {
			if (m.role === vscode.LanguageModelChatMessageRole.User) {
				bedrockMessages.push({ role: "user", content: [{ text }] });
			} else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
				bedrockMessages.push({ role: "assistant", content: [{ text }] });
			}
		}
	}

	if (pendingToolResults.length > 0) {
		bedrockMessages.push({ role: "user", content: pendingToolResults });
	}

	logger.log("[Message Converter] === DETAILED MESSAGE DUMP ===");
	bedrockMessages.forEach((msg, idx) => {
		logger.log(`[Message Converter] Message ${idx} (${msg.role}):`);
		logger.log(JSON.stringify(msg, null, 2));
	});
	logger.log("[Message Converter] === END MESSAGE DUMP ===");

	return { messages: bedrockMessages, system: systemBlocks };
}
