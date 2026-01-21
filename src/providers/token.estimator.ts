import * as vscode from "vscode";
import type { LanguageModelChatInformation, LanguageModelChatMessage } from "vscode";

/**
 * Handles token counting for messages and text.
 * Uses simple character-based estimation (4 characters per token).
 */
export class TokenEstimator {
	/**
	 * Estimate token count for text or message
	 */
	estimateTokens(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage
	): number {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / 4);
				}
			}
			return totalTokens;
		}
	}

	/**
	 * Estimate token count for an array of messages
	 */
	estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += Math.ceil(part.value.length / 4);
				}
			}
		}
		return total;
	}

	/**
	 * Estimate token count for tool configuration
	 */
	estimateToolTokens(
		toolConfig: { tools: Array<{ toolSpec: { name: string; description?: string; inputSchema: { json: object } } }> } | undefined
	): number {
		if (!toolConfig || toolConfig.tools.length === 0) {
			return 0;
		}
		try {
			const json = JSON.stringify(toolConfig);
			return Math.ceil(json.length / 4);
		} catch {
			return 0;
		}
	}
}
