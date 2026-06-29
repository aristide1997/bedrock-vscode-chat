import * as vscode from "vscode";
import type {
	BedrockMessage,
	BedrockContentBlock,
	BedrockTextBlock,
	BedrockImageBlock,
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
		const imageBlocks: BedrockImageBlock[] = [];
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
			} else if (typeof part === 'object' && part !== null && 'mimeType' in part && 'data' in part) {
				const dataPart = part as { mimeType: string; data: Uint8Array };
				if (dataPart.mimeType.startsWith('image/')) {
					// Detect actual image format from magic bytes to handle cases where
					// the reported mimeType doesn't match the actual image data
					let actualFormat: string | null = null;
					const bytes = dataPart.data;
					
					if (bytes instanceof Uint8Array && bytes.length >= 12) {
						// PNG: 89 50 4E 47
						if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
							actualFormat = 'png';
						}
						// JPEG: FF D8 FF
						else if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
							actualFormat = 'jpeg';
						}
						// GIF: 47 49 46 38
						else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
							actualFormat = 'gif';
						}
						// WebP: RIFF ... WEBP
						else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
								 bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
							actualFormat = 'webp';
						}
					}
					
					// Fall back to mimeType if detection fails
					if (!actualFormat) {
						const mimeTypeParts = dataPart.mimeType.split('/');
						actualFormat = mimeTypeParts[1]?.toLowerCase();
						// Normalize jpg to jpeg
						if (actualFormat === 'jpg') {
							actualFormat = 'jpeg';
						}
					}
					
					logger.log(`[Message Converter] Image detected - mimeType: ${dataPart.mimeType}, actual format: ${actualFormat}`);

					if (actualFormat === 'png' || actualFormat === 'jpeg' || actualFormat === 'gif' || actualFormat === 'webp') {
						imageBlocks.push({
							image: {
								format: actualFormat as "png" | "jpeg" | "gif" | "webp",
								source: {
									bytes: dataPart.data,
								},
							},
						});
						logger.log(`[Message Converter] Added image block with format: ${actualFormat}`);
					} else {
						logger.warn(`[Message Converter] Unsupported image format: ${actualFormat}`);
					}
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
			content.push(...imageBlocks);
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
		if ((text || imageBlocks.length > 0) && !emittedAssistantToolCall && toolResults.length === 0) {
			if (m.role === vscode.LanguageModelChatMessageRole.User) {
				const content: BedrockContentBlock[] = [];
				if (text) {
					content.push({ text });
				}
				content.push(...imageBlocks);
				bedrockMessages.push({ role: "user", content });
			} else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
				const content: BedrockContentBlock[] = [];
				if (text) {
					content.push({ text });
				}
				content.push(...imageBlocks);
				bedrockMessages.push({ role: "assistant", content });
			}
		}
	}

	if (pendingToolResults.length > 0) {
		bedrockMessages.push({ role: "user", content: pendingToolResults });
	}

	return { messages: bedrockMessages, system: systemBlocks };
}
