import * as vscode from "vscode";
import type {
	BedrockMessage,
	BedrockContentBlock,
	BedrockImageBlock,
	BedrockToolUseBlock,
	BedrockToolResultBlock,
	BedrockSystemBlock,
	ReasoningBlock,
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

/**
 * Flatten a tool result's content into text.
 *
 * Handles more than plain text parts on purpose. Tools increasingly return
 * structured payloads, and the previous text-only walk silently produced an
 * empty string for those. Bedrock rejects an empty toolResult, so a tool that
 * returned only structured data would fail the whole turn.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c && typeof c === "object") {
			const obj = c as Record<string, unknown>;
			// LanguageModelTextPart from a different extension-host realm fails the
			// instanceof check, so fall back to its shape.
			if (typeof obj.value === "string") {
				text += obj.value;
			} else if (typeof obj.text === "string") {
				text += obj.text;
			} else if ("data" in obj && typeof obj.mimeType === "string") {
				// Binary tool output cannot go into a text block; describe it instead
				// of emitting nothing.
				text += `[${obj.mimeType} data]`;
			} else {
				try {
					text += JSON.stringify(obj);
				} catch {
					// Circular or otherwise unserializable: skip rather than throw.
				}
			}
		}
	}
	return text;
}

/**
 * Resolve an image's format, preferring the actual bytes over the reported mimeType.
 * VS Code's browser attachment can report an incorrect mimeType (e.g. image/jpeg for
 * PNG data), which Bedrock rejects with a ValidationException. When the leading magic
 * bytes identify a known format we trust them; otherwise we fall back to the mimeType
 * subtype (normalizing jpg -> jpeg). Returns null when nothing determinable.
 */
export function detectImageFormat(bytes: Uint8Array | undefined, mimeType: string): string | null {
	if (bytes instanceof Uint8Array && bytes.length >= 12) {
		if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
			return 'png';
		}
		if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
			return 'jpeg';
		}
		if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
			return 'gif';
		}
		if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
			bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
			return 'webp';
		}
	}

	const subtype = mimeType.split('/')[1]?.toLowerCase();
	if (!subtype) {
		return null;
	}
	return subtype === 'jpg' ? 'jpeg' : subtype;
}

export interface ConvertMessagesOptions {
	/**
	 * Reasoning blocks captured from earlier turns, keyed by a toolUseId that the
	 * turn produced. Bedrock requires signed reasoning to be replayed verbatim on
	 * the follow-up request when extended thinking is combined with tool use, so
	 * whichever assistant message carries that toolUse gets its reasoning restored.
	 */
	reasoningByToolUseId?: ReadonlyMap<string, ReasoningBlock[]>;
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelId: string,
	options: ConvertMessagesOptions = {}
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
					const actualFormat = detectImageFormat(dataPart.data, dataPart.mimeType);
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
					// Bedrock rejects an empty text block, so substitute a marker when a
					// tool genuinely produced nothing.
					content = [{ text: resultText.length > 0 ? resultText : "(no output)" }];
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
			// Reasoning has to lead the message; Anthropic rejects a thinking block
			// that follows text or a tool use.
			content.push(...replayReasoning(toolCalls, options.reasoningByToolUseId));
			const combinedText = textParts.join("");
			if (combinedText) {
				content.push({ text: combinedText });
			}
			content.push(...imageBlocks);
			content.push(...toolCalls);
			bedrockMessages.push({ role: "assistant", content });
			emittedAssistantToolCall = true;
		}

		const text = textParts.join("");

		if (toolResults.length > 0) {
			pendingToolResults.push(...toolResults);

			const nextMessage = i + 1 < messages.length ? messages[i + 1] : undefined;
			const nextIsToolResultOnly = nextMessage &&
				nextMessage.role === vscode.LanguageModelChatMessageRole.User &&
				nextMessage.content.every(p => isToolResultPart(p));

			if (!nextIsToolResultOnly && pendingToolResults.length > 0) {
				// Any text or images sharing this message ride along after the tool
				// results. Previously they were dropped outright, which silently lost
				// user instructions attached to a tool-result turn.
				const content: BedrockContentBlock[] = [...pendingToolResults];
				if (text) {
					content.push({ text });
				}
				content.push(...imageBlocks);
				bedrockMessages.push({ role: "user", content });
				pendingToolResults = [];
			}
		}

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

	return { messages: reconcileToolBlocks(bedrockMessages), system: systemBlocks };
}

function replayReasoning(
	toolCalls: BedrockToolUseBlock[],
	reasoningByToolUseId: ReadonlyMap<string, ReasoningBlock[]> | undefined
): BedrockContentBlock[] {
	if (!reasoningByToolUseId || reasoningByToolUseId.size === 0) {
		return [];
	}
	for (const call of toolCalls) {
		const blocks = reasoningByToolUseId.get(call.toolUse.toolUseId);
		if (!blocks || blocks.length === 0) {
			continue;
		}
		return blocks.map((b) =>
			b.redactedContent
				? ({ reasoningContent: { redactedContent: b.redactedContent } } as BedrockContentBlock)
				: ({
						reasoningContent: {
							reasoningText: { text: b.text, ...(b.signature ? { signature: b.signature } : {}) },
						},
					} as BedrockContentBlock)
		);
	}
	return [];
}

/**
 * Make tool_use and tool_result blocks pair up the way Bedrock demands.
 *
 * Bedrock answers a mismatch with a 400 that names neither the message nor the
 * id, so the two failure modes are worth fixing here rather than debugging in
 * the log:
 *
 * 1. A tool result whose tool_use is not in the immediately preceding assistant
 *    message. This happens after Copilot edits or truncates history, or when the
 *    provider dropped a malformed tool call earlier in the session. The result is
 *    unanswerable, so it is dropped.
 * 2. A tool_use with no matching result. Rather than let the request fail, a
 *    synthetic error result is inserted so the model learns the call did not run
 *    and can retry.
 *
 * Exported for direct unit testing.
 */
export function reconcileToolBlocks(messages: BedrockMessage[]): BedrockMessage[] {
	const out: BedrockMessage[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const prev = out[out.length - 1];
			const availableIds = new Set<string>();
			if (prev && prev.role === "assistant") {
				for (const block of prev.content) {
					if ("toolUse" in block) {
						availableIds.add(block.toolUse.toolUseId);
					}
				}
			}

			const seen = new Set<string>();
			const kept: BedrockContentBlock[] = [];
			for (const block of message.content) {
				if ("toolResult" in block) {
					const id = block.toolResult.toolUseId;
					if (!availableIds.has(id)) {
						logger.warn("[Message Converter] Dropping orphan tool result", { toolUseId: id });
						continue;
					}
					if (seen.has(id)) {
						logger.warn("[Message Converter] Dropping duplicate tool result", { toolUseId: id });
						continue;
					}
					seen.add(id);
				}
				kept.push(block);
			}

			// Answer any tool call the client never reported a result for.
			for (const id of availableIds) {
				if (!seen.has(id)) {
					logger.warn("[Message Converter] Synthesizing missing tool result", { toolUseId: id });
					kept.unshift({
						toolResult: {
							toolUseId: id,
							content: [{ text: "Tool result unavailable." }],
							status: "error",
						},
					});
				}
			}

			if (kept.length > 0) {
				out.push({ role: "user", content: kept });
			}
			continue;
		}

		out.push(message);
	}

	// A trailing assistant tool_use with nothing after it is invalid: Bedrock
	// requires every tool call to be answered before the model is asked to
	// continue. Append the results the client owed us.
	const last = out[out.length - 1];
	if (last && last.role === "assistant") {
		const unanswered = last.content.filter((b): b is BedrockToolUseBlock => "toolUse" in b);
		if (unanswered.length > 0) {
			out.push({
				role: "user",
				content: unanswered.map((b) => ({
					toolResult: {
						toolUseId: b.toolUse.toolUseId,
						content: [{ text: "Tool result unavailable." }],
						status: "error" as const,
					},
				})),
			});
		}
	}

	return out;
}
