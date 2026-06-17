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
	/** Whether a thinking part was successfully emitted to the UI this turn. */
	private emittedThinking = false;
	/** Reasoning accumulated this turn (for capture / multi-turn replay). */
	private capturedReasoning: CapturedReasoning = { text: "" };
	/**
	 * Cached proposed-API constructor: a function when available, `null` when
	 * confirmed unavailable/rejected, `undefined` before the first probe.
	 */
	private thinkingPartCtor: any = undefined;

	constructor() {
		this.toolBuffer = new ToolCallBufferManager();
	}

	/** Reasoning captured during the most recent processStream call. */
	getCapturedReasoning(): CapturedReasoning | undefined {
		return this.capturedReasoning.text.length > 0 ? this.capturedReasoning : undefined;
	}

	/**
	 * Emit a reasoning delta to the chat UI.
	 *
	 * `LanguageModelThinkingPart` is a proposed API that may not exist at runtime
	 * (it is absent from the stable vscode.d.ts). We probe it dynamically and wrap
	 * progress.report in try/catch because the host can also reject the part when
	 * the proposal isn't enabled. Falls back to plain text so reasoning stays visible.
	 */
	private emitReasoning(
		text: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): void {
		// Resolve the proposed LanguageModelThinkingPart constructor once. It is
		// absent from the stable vscode.d.ts but available at runtime for providers
		// registered via `languageModelChatProviders`. Caching avoids per-delta
		// probing that could introduce micro-buffering during live streaming.
		if (this.thinkingPartCtor === undefined) {
			const ctor = (vscode as any).LanguageModelThinkingPart;
			this.thinkingPartCtor = typeof ctor === "function" ? ctor : null;
			if (this.thinkingPartCtor === null) {
				logger.debug("[StreamProcessor] LanguageModelThinkingPart not available at runtime; falling back to text");
			}
		}

		if (this.thinkingPartCtor) {
			try {
				// Emit each delta as its own thinking part WITHOUT an id so the
				// workbench merges consecutive parts into the single active thinking
				// block and renders them incrementally (live streaming). The id is
				// attached only when the block finalizes (see finalizeReasoning).
				progress.report(new this.thinkingPartCtor(text));
				this.emittedThinking = true;
				return;
			} catch (error: unknown) {
				const isApiMissing =
					error instanceof TypeError ||
					error instanceof ReferenceError ||
					String(error).includes("LanguageModelThinkingPart");
				if (!isApiMissing) {
					throw error;
				}
				// Host rejected the proposed part — disable for the rest of the stream.
				this.thinkingPartCtor = null;
				logger.debug("[StreamProcessor] LanguageModelThinkingPart rejected by host; falling back to text");
			}
		}

		// Fallback: render reasoning as plain text so it remains visible.
		progress.report(new vscode.LanguageModelTextPart(text));
	}

	async processStream(
		stream: AsyncIterable<any>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		this.toolBuffer.reset();
		this.emittedThinking = false;
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
			// Stream these BEFORE answer text so the UI shows thinking first, and
			// capture them BEFORE any tool call so interleaved thinking round-trips.
			const reasoning = delta?.reasoningContent;
			if (reasoning) {
				const reasoningText =
					typeof reasoning.text === "string" ? reasoning.text : undefined;
				if (reasoningText) {
					this.capturedReasoning.text += reasoningText;
					this.emitReasoning(reasoningText, progress);
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
