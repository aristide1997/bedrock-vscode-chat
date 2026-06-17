import * as vscode from "vscode";
import type {
	BedrockMessage,
	BedrockContentBlock,
	BedrockImageBlock,
	BedrockToolUseBlock,
	BedrockToolResultBlock,
	BedrockReasoningBlock,
	BedrockSystemBlock,
} from "../types";
import { logger } from "../logger";
import { getModelProfile } from "../profiles";

/** Captured reasoning from a prior assistant turn (for tool-use replay). */
export interface CapturedReasoning {
	text: string;
	signature?: string;
}

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
 * Safely collect text from an arbitrary tool/hook result. Tool results can be
 * produced by external hooks or tasks and may contain anything: plain strings,
 * text parts, nested objects, arrays, numbers, null, or circular structures.
 * This must NEVER throw and must always return a string (requirement: arbitrary
 * results must not crash the extension).
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	const parts: string[] = [];
	const content = pr?.content;
	if (content == null) {
		return "";
	}
	const items: ReadonlyArray<unknown> = Array.isArray(content) ? content : [content];
	for (const c of items) {
		try {
			if (c == null) {
				continue;
			}
			if (c instanceof vscode.LanguageModelTextPart) {
				parts.push(c.value);
			} else if (typeof c === "string") {
				parts.push(c);
			} else if (typeof c === "object") {
				// Tool result parts may wrap text/data; pull common shapes first.
				const obj = c as Record<string, unknown>;
				if (typeof obj.value === "string") {
					parts.push(obj.value);
				} else if (typeof obj.text === "string") {
					parts.push(obj.text);
				} else {
					parts.push(safeStringify(obj));
				}
			} else {
				// numbers, booleans, bigint, symbol, etc.
				parts.push(String(c));
			}
		} catch (e) {
			logger.warn("[Message Converter] Skipped unserializable tool result item", e);
		}
	}
	return parts.join("");
}

/** JSON.stringify that tolerates circular refs, BigInt, and stringify errors. */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === "bigint") {
				return v.toString();
			}
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) {
					return "[Circular]";
				}
				seen.add(v);
			}
			return v;
		}) ?? "";
	} catch {
		try {
			return String(value);
		} catch {
			return "";
		}
	}
}

/**
 * Inject a previously-captured signed thinking block into the most recent
 * assistant message that doesn't already carry reasoning. Anthropic models
 * (especially Opus 4.8 with automatic interleaved thinking) require the signed
 * `reasoningContent` block to be replayed during tool-use loops, or the request
 * is rejected with a 400. No-op when there is no signature to replay.
 */
function injectExtendedThinking(
	bedrockMessages: BedrockMessage[],
	thinking: CapturedReasoning | undefined
): void {
	if (!thinking?.signature || !thinking.text) {
		// Without a signature the block can't be verified by the API — skip rather
		// than send an unsigned block that would be rejected.
		return;
	}

	let lastAssistantIdx = -1;
	for (let i = bedrockMessages.length - 1; i >= 0; i--) {
		const msg = bedrockMessages[i];
		if (msg.role === "assistant" && msg.content.length > 0) {
			const hasReasoning = msg.content.some(
				(b) => "reasoningContent" in b || "thinking" in (b as unknown as Record<string, unknown>)
			);
			if (!hasReasoning) {
				lastAssistantIdx = i;
			}
			break;
		}
	}

	if (lastAssistantIdx === -1) {
		return;
	}

	const reasoningBlock: BedrockReasoningBlock = {
		reasoningContent: {
			reasoningText: {
				signature: thinking.signature,
				text: thinking.text,
			},
		},
	};
	// Reasoning must be the FIRST content block of the assistant turn.
	bedrockMessages[lastAssistantIdx].content.unshift(reasoningBlock);
	logger.log("[Message Converter] Injected thinking block into assistant message", {
		index: lastAssistantIdx,
		signatureLength: thinking.signature.length,
		textLength: thinking.text.length,
	});
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelId: string,
	priorReasoning?: CapturedReasoning
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
					const mimeTypeParts = dataPart.mimeType.split('/');
					const format = mimeTypeParts[1]?.toLowerCase();

					if (format === 'png' || format === 'jpeg' || format === 'gif' || format === 'webp') {
						imageBlocks.push({
							image: {
								format: format as "png" | "jpeg" | "gif" | "webp",
								source: {
									bytes: dataPart.data,
								},
							},
						});
						logger.log(`[Message Converter] Added image block with format: ${format}`);
					} else {
						logger.warn(`[Message Converter] Unsupported image format: ${format}`);
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

	// Reconcile tool_use <-> tool_result pairing. VS Code normally guarantees
	// pairing, but background/late/out-of-order tool results (or partial history)
	// can produce orphan tool results or unanswered tool calls, which Bedrock
	// rejects with a 400. Sanitizing here keeps the request valid no matter what.
	reconcileToolBlocks(bedrockMessages);

	// Replay the signed thinking block from the prior assistant turn so that
	// interleaved thinking + tool use works (otherwise Anthropic returns a 400).
	injectExtendedThinking(bedrockMessages, priorReasoning);

	return { messages: bedrockMessages, system: systemBlocks };
}

/**
 * Ensure tool_use and tool_result blocks are correctly paired so the request is
 * always valid for Bedrock, even when results arrive late / out of order / partial.
 *
 * Two Bedrock rules are enforced:
 *  1. Every toolResult must reference a toolUse from the immediately-preceding
 *     assistant turn. Orphan tool results (e.g. a background task that completed
 *     after its turn ended, or duplicate/late results) are dropped.
 *  2. Every toolUse must be answered by a toolResult in the next user turn.
 *     Unanswered tool calls get a synthetic placeholder result so the
 *     conversation stays well-formed.
 */
function reconcileToolBlocks(messages: BedrockMessage[]): void {
	const toolUseIds = (msg: BedrockMessage): Set<string> => {
		const ids = new Set<string>();
		for (const b of msg.content) {
			if ("toolUse" in b && b.toolUse?.toolUseId) {
				ids.add(b.toolUse.toolUseId);
			}
		}
		return ids;
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user") {
			continue;
		}

		const resultBlocks = msg.content.filter((b): b is BedrockToolResultBlock => "toolResult" in b);
		if (resultBlocks.length === 0) {
			continue;
		}

		const prev = i > 0 ? messages[i - 1] : undefined;
		const allowedIds = prev && prev.role === "assistant" ? toolUseIds(prev) : new Set<string>();

		// Rule 1: drop orphan tool results that don't match a preceding toolUse,
		// and de-duplicate repeated results for the same toolUseId (late retries).
		const seen = new Set<string>();
		const keptResults: BedrockToolResultBlock[] = [];
		const droppedIds: string[] = [];
		for (const rb of resultBlocks) {
			const id = rb.toolResult?.toolUseId ?? "";
			if (!allowedIds.has(id) || seen.has(id)) {
				droppedIds.push(id || "(missing)");
				continue;
			}
			seen.add(id);
			keptResults.push(rb);
		}
		if (droppedIds.length > 0) {
			logger.warn("[Message Converter] Dropped orphan/duplicate tool result(s)", { droppedIds });
			const nonResults = msg.content.filter((b) => !("toolResult" in b));
			msg.content = [...keptResults, ...nonResults];
		}
	}

	// Rule 2: synthesize placeholder results for any unanswered tool calls.
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") {
			continue;
		}
		const callIds = Array.from(toolUseIds(msg));
		if (callIds.length === 0) {
			continue;
		}

		const next = i + 1 < messages.length ? messages[i + 1] : undefined;
		const answered = new Set<string>();
		if (next && next.role === "user") {
			for (const b of next.content) {
				if ("toolResult" in b && b.toolResult?.toolUseId) {
					answered.add(b.toolResult.toolUseId);
				}
			}
		}

		const missing = callIds.filter((id) => !answered.has(id));
		if (missing.length === 0) {
			continue;
		}

		const placeholders: BedrockToolResultBlock[] = missing.map((id) => ({
			toolResult: {
				toolUseId: id,
				content: [{ text: "Tool result unavailable (no response was produced for this call)." }],
				status: "error",
			},
		}));
		logger.warn("[Message Converter] Synthesized placeholder result(s) for unanswered tool call(s)", { missing });

		if (next && next.role === "user") {
			// Prepend placeholders so they sit alongside the real results.
			next.content = [...placeholders, ...next.content];
		} else {
			messages.splice(i + 1, 0, { role: "user", content: placeholders });
		}
	}
}
