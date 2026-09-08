import * as vscode from "vscode";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { ToolCallBufferManager } from "./tool-buffer";
import { createThinkingReporter, type ThinkingDisplay } from "./thinking";
import type { ReasoningBlock, StreamResult } from "./types";
import { logger } from "./logger";

/**
 * Drains a Bedrock ConverseStream and reports its parts to VS Code.
 *
 * Stateless between calls on purpose. Every mutable structure a response needs
 * (tool-argument buffers, reasoning blocks, counters) is created inside
 * processStream, because VS Code issues chat requests concurrently and shared
 * state let one request wipe another's half-accumulated tool arguments.
 */
export class StreamProcessor {
	async processStream(
		stream: AsyncIterable<ConverseStreamOutput>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
		options: { thinkingDisplay?: ThinkingDisplay } = {}
	): Promise<StreamResult> {
		const toolBuffer = new ToolCallBufferManager();
		const thinking = createThinkingReporter(progress, options.thinkingDisplay ?? "hidden");
		const reasoning: ReasoningBlock[] = [];
		let textLength = 0;
		let stopReason: string | undefined;
		let usage: StreamResult["usage"];
		let latencyMs: number | undefined;

		/** Index of the content block currently accumulating reasoning, if any. */
		let reasoningIndex: number | undefined;

		const currentReasoning = (): ReasoningBlock => {
			if (reasoning.length === 0) {
				reasoning.push({ text: "" });
			}
			return reasoning[reasoning.length - 1];
		};

		try {
			for await (const event of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				// Isolate per-event failures. A single malformed event should not
				// abandon the rest of the response, which previously turned one bad
				// block into a silently truncated turn.
				try {
					if (event.contentBlockStart) {
						const idx = event.contentBlockStart.contentBlockIndex ?? 0;
						const toolUse = event.contentBlockStart.start?.toolUse;
						if (toolUse) {
							if (toolBuffer.shouldAddSpaceBeforeFirstTool()) {
								progress.report(new vscode.LanguageModelTextPart(" "));
							}
							toolBuffer.startToolCall(idx, toolUse.toolUseId || "", toolUse.name || "");
							toolBuffer.markFirstToolEmitted();
						}
					} else if (event.contentBlockDelta) {
						const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
						const delta = event.contentBlockDelta.delta;

						const reasoningDelta = delta?.reasoningContent;
						if (reasoningDelta) {
							// A new block index means a new reasoning block, not a
							// continuation of the previous one.
							if (reasoningIndex !== idx) {
								reasoningIndex = idx;
								reasoning.push({ text: "" });
							}
							const block = currentReasoning();

							if (typeof reasoningDelta.text === "string" && reasoningDelta.text.length > 0) {
								block.text += reasoningDelta.text;
								thinking.delta(reasoningDelta.text);
							}
							// The signature arrives in its own delta at the end of the
							// block. It must be replayed verbatim next turn or Bedrock
							// rejects the request.
							if (typeof reasoningDelta.signature === "string" && reasoningDelta.signature.length > 0) {
								block.signature = (block.signature ?? "") + reasoningDelta.signature;
							}
							if (reasoningDelta.redactedContent) {
								block.redactedContent = reasoningDelta.redactedContent;
							}
						}

						if (delta?.text) {
							progress.report(new vscode.LanguageModelTextPart(delta.text));
							textLength += delta.text.length;
							toolBuffer.markHasText();
						}

						if (delta?.toolUse?.input !== undefined) {
							toolBuffer.appendArgs(idx, delta.toolUse.input);
							await toolBuffer.tryEmit(idx, progress);
						}
					} else if (event.contentBlockStop) {
						const idx = event.contentBlockStop.contentBlockIndex ?? 0;
						if (idx === reasoningIndex) {
							thinking.end();
						}
						await toolBuffer.tryEmit(idx, progress, true);
					} else if (event.messageStop) {
						thinking.end();
						stopReason = event.messageStop.stopReason;
						await toolBuffer.emitAll(progress);
					} else if (event.metadata) {
						// Bedrock's own accounting: authoritative token counts, and the
						// only place cache hits/writes are reported.
						const m = event.metadata;
						if (m.usage) {
							usage = {
								inputTokens: m.usage.inputTokens,
								outputTokens: m.usage.outputTokens,
								totalTokens: m.usage.totalTokens,
								cacheReadInputTokens: m.usage.cacheReadInputTokens,
								cacheWriteInputTokens: m.usage.cacheWriteInputTokens,
							};
						}
						if (m.metrics?.latencyMs !== undefined) {
							latencyMs = m.metrics.latencyMs;
						}
					} else if (isStreamException(event)) {
						// Bedrock reports mid-stream faults as events rather than
						// throwing, so surface them instead of ending the turn quietly.
						throw toStreamError(event);
					}
				} catch (eventError) {
					if (isFatalStreamError(eventError)) {
						throw eventError;
					}
					logger.error("[Stream Processor] Failed to process stream event", {
						error: eventError instanceof Error ? eventError.message : String(eventError),
					});
				}
			}

			// Close out anything the stream ended without stopping cleanly.
			thinking.end();
			await toolBuffer.emitAll(progress);
		} catch (err) {
			// Cancellation aborts the underlying HTTP request, which surfaces as a
			// read error. That is expected, not a failure.
			if (token.isCancellationRequested) {
				logger.log("[Stream Processor] Stream ended due to cancellation");
			} else {
				throw err;
			}
		}

		return {
			stopReason,
			usage,
			latencyMs,
			toolCallFailures: [...toolBuffer.getFailures()],
			emittedToolCalls: toolBuffer.getEmittedIds().length,
			textLength,
			reasoning: reasoning.filter((r) => r.text.length > 0 || r.redactedContent !== undefined),
			toolUseIds: [...toolBuffer.getEmittedIds()],
		};
	}
}

/** Marker so per-event isolation does not swallow a genuine stream fault. */
class StreamException extends Error {}

function isFatalStreamError(err: unknown): boolean {
	return err instanceof StreamException;
}

interface ExceptionEvent {
	internalServerException?: { message?: string };
	modelStreamErrorException?: { message?: string; originalStatusCode?: number };
	validationException?: { message?: string };
	throttlingException?: { message?: string };
	serviceUnavailableException?: { message?: string };
}

function isStreamException(event: ConverseStreamOutput): boolean {
	const e = event as ExceptionEvent;
	return Boolean(
		e.internalServerException ??
			e.modelStreamErrorException ??
			e.validationException ??
			e.throttlingException ??
			e.serviceUnavailableException
	);
}

function toStreamError(event: ConverseStreamOutput): StreamException {
	const e = event as ExceptionEvent;
	const found = (
		[
			["InternalServerException", e.internalServerException],
			["ModelStreamErrorException", e.modelStreamErrorException],
			["ValidationException", e.validationException],
			["ThrottlingException", e.throttlingException],
			["ServiceUnavailableException", e.serviceUnavailableException],
		] as const
	).find(([, value]) => value !== undefined);

	const name = found?.[0] ?? "StreamError";
	const message = found?.[1]?.message ?? "Bedrock reported an error mid-stream";
	const error = new StreamException(`${name}: ${message}`);
	error.name = name;
	return error;
}
