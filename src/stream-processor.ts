import * as vscode from "vscode";
import { ToolCallBufferManager } from "./tool-buffer";
import { logger } from "./logger";

/**
 * Reasoning captured from a single assistant turn.
 * `signature` must be echoed back on follow-up turns (Anthropic on Bedrock
 * rejects multi-turn tool use if the signed thinking block isn't replayed).
 */
export interface CapturedReasoning {
	text: string;
	signature?: string;
}

export class StreamProcessor {
	private toolBuffer: ToolCallBufferManager;
	/** Reasoning accumulated this turn (for capture / multi-turn replay). */
	private capturedReasoning: CapturedReasoning = { text: "" };

	constructor() {
		this.toolBuffer = new ToolCallBufferManager();
	}

	/** Reasoning captured during the most recent processStream call. */
	getCapturedReasoning(): CapturedReasoning | undefined {
		return this.capturedReasoning.text.length > 0 ? this.capturedReasoning : undefined;
	}

	async processStream(
		stream: AsyncIterable<any>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		this.toolBuffer.reset();
		this.capturedReasoning = { text: "" };

		try {
			for await (const event of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				try {
					await this.handleEvent(event, progress);
				} catch (eventErr) {
					// A single malformed event (e.g. from an arbitrary tool/hook result)
					// must not tear down the whole stream. Log and continue.
					if (token.isCancellationRequested) {
						break;
					}
					logger.error("[StreamProcessor] Error handling stream event; continuing", eventErr);
				}
			}
		} catch (err) {
			// Suppress errors when cancellation was requested, since it is expected in that case.
			if (!token.isCancellationRequested) {
				throw err;
			}
			logger.log("[StreamProcessor] Stream error suppressed due to cancellation", err);
		} finally {
			this.toolBuffer.reset();
		}
	}

	/** Handle a single Converse stream event. */
	private async handleEvent(
		event: any,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		if (event.contentBlockStart) {
			const idx = event.contentBlockStart.contentBlockIndex ?? 0;
			const start = event.contentBlockStart.start;

			const toolUse = start?.toolUse;

			if (toolUse) {
				if (this.toolBuffer.shouldAddSpaceBeforeFirstTool()) {
					progress.report(new vscode.LanguageModelTextPart(' '));
				}
				this.toolBuffer.startToolCall(idx, toolUse.toolUseId || "", toolUse.name || "");
				this.toolBuffer.markFirstToolEmitted();
			}
		} else if (event.contentBlockDelta) {
			const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
			const delta = event.contentBlockDelta.delta;

			// Reasoning / extended thinking deltas (Anthropic on Bedrock).
			// We capture reasoning (text + signature) but do NOT emit it to the
			// chat UI: the only dedicated reasoning surface, LanguageModelThinkingPart,
			// is a proposed API, and enabling API proposals blocks Marketplace
			// publishing. Capture must still happen BEFORE any tool call so the
			// signed thinking block round-trips on multi-turn tool use (Anthropic
			// rejects the follow-up request otherwise).
			const reasoning = delta?.reasoningContent;
			if (reasoning) {
				const reasoningText =
					typeof reasoning.text === "string" ? reasoning.text : undefined;
				if (reasoningText) {
					this.capturedReasoning.text += reasoningText;
				}
				// The signature arrives on its own delta and must be retained
				// for multi-turn replay of the signed thinking block.
				if (typeof reasoning.signature === "string") {
					this.capturedReasoning.signature = reasoning.signature;
				}
			}

			if (delta?.text) {
				progress.report(new vscode.LanguageModelTextPart(delta.text));
				if (delta.text.length > 0) {
					this.toolBuffer.markHasText();
				}
			}

			// Tool-use input streams in fragments; emit the tool call as soon as
			// its accumulated JSON becomes valid (incremental tool streaming).
			if (delta?.toolUse?.input !== undefined && delta?.toolUse?.input !== null) {
				this.toolBuffer.appendArgs(idx, String(delta.toolUse.input));
				await this.toolBuffer.tryEmit(idx, progress);
			}
		} else if (event.contentBlockStop) {
			const idx = event.contentBlockStop.contentBlockIndex ?? 0;
			await this.toolBuffer.tryEmit(idx, progress, true);
		} else if (event.messageStop) {
			await this.toolBuffer.emitAll(progress);
		}
	}
}
