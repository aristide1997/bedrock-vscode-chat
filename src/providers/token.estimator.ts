import * as vscode from "vscode";
import type { LanguageModelChatInformation, LanguageModelChatMessage } from "vscode";
import type { BedrockToolConfig } from "../types";

/** Characters per token. Crude, but consistent across every part type. */
const CHARS_PER_TOKEN = 4;

/**
 * Per-message overhead for role markers and block framing. Anthropic's own
 * accounting charges a handful of tokens per message; without it a long
 * conversation is under-counted by hundreds of tokens.
 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Flat cost for an image. A real figure depends on resolution (roughly
 * width*height/750 for Claude); this is the mid-range value for a screenshot,
 * chosen so images stop counting as zero.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Handles token counting for messages and text.
 *
 * Character-based estimation. It used to count only text parts, so a session
 * full of tool calls, tool results and images reported a tiny number and the
 * context-window indicator sat at nearly empty regardless of the real usage.
 * Every part type now contributes.
 */
export class TokenEstimator {
	/**
	 * Estimate token count for text or message
	 */
	estimateTokens(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage
	): number {
		if (typeof text === "string") {
			return Math.ceil(text.length / CHARS_PER_TOKEN);
		}
		return this.estimateMessageTokens(text);
	}

	/**
	 * Estimate token count for an array of messages
	 */
	estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			total += this.estimateMessageTokens(m);
		}
		return total;
	}

	/** Estimate the cost of one message, including every content part type. */
	estimateMessageTokens(message: LanguageModelChatMessage): number {
		let total = PER_MESSAGE_OVERHEAD;
		for (const part of message.content ?? []) {
			total += this.estimatePartTokens(part);
		}
		return total;
	}

	private estimatePartTokens(part: unknown): number {
		if (part instanceof vscode.LanguageModelTextPart) {
			return Math.ceil(part.value.length / CHARS_PER_TOKEN);
		}

		if (part instanceof vscode.LanguageModelToolCallPart) {
			// The model pays for the serialized arguments plus the tool name.
			return Math.ceil((part.name.length + jsonLength(part.input)) / CHARS_PER_TOKEN) + 8;
		}

		if (!part || typeof part !== "object") {
			return 0;
		}

		const obj = part as Record<string, unknown>;

		// Image or other binary data part.
		if ("data" in obj && typeof obj.mimeType === "string") {
			if (obj.mimeType.startsWith("image/")) {
				return IMAGE_TOKEN_ESTIMATE;
			}
			const data = obj.data;
			return data instanceof Uint8Array ? Math.ceil(data.byteLength / CHARS_PER_TOKEN) : 0;
		}

		// Tool result part: { callId, content: [...] }.
		if (typeof obj.callId === "string" && "content" in obj) {
			const content = Array.isArray(obj.content) ? obj.content : [];
			let total = 8;
			for (const item of content) {
				total += this.estimatePartTokens(item);
			}
			// A structured result contributes nothing above, so fall back to its
			// serialized size rather than reporting only the framing overhead.
			if (total === 8 && content.length > 0) {
				total += Math.ceil(jsonLength(content) / CHARS_PER_TOKEN);
			}
			return total;
		}

		if (typeof obj.value === "string") {
			return Math.ceil(obj.value.length / CHARS_PER_TOKEN);
		}

		return Math.ceil(jsonLength(obj) / CHARS_PER_TOKEN);
	}

	/**
	 * Estimate token count for tool configuration
	 */
	estimateToolTokens(toolConfig: BedrockToolConfig | undefined): number {
		if (!toolConfig || toolConfig.tools.length === 0) {
			return 0;
		}
		return Math.ceil(jsonLength(toolConfig) / CHARS_PER_TOKEN);
	}

	/** Estimate token count for the system prompt blocks. */
	estimateSystemTokens(system: ReadonlyArray<{ text?: string }>): number {
		let total = 0;
		for (const block of system) {
			if (typeof block.text === "string") {
				total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
			}
		}
		return total;
	}
}

function jsonLength(value: unknown): number {
	if (value === undefined || value === null) {
		return 0;
	}
	if (typeof value === "string") {
		return value.length;
	}
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}
