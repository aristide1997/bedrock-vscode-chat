import * as vscode from "vscode";
import { ToolCallBufferManager } from "./tool-buffer";
import { logger } from "./logger";

/**
 * Bedrock ConverseStream exception events surface in-band as members on the
 * stream event union rather than throwing. Consumers must inspect for these
 * or a mid-stream throttle / model error is silently discarded — the caller
 * sees the assistant turn simply end.
 *
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
 */
const STREAM_EXCEPTION_EVENTS = [
	"internalServerException",
	"modelStreamErrorException",
	"validationException",
	"throttlingException",
	"serviceUnavailableException",
] as const;

type StreamExceptionEvent = (typeof STREAM_EXCEPTION_EVENTS)[number];

interface BedrockExceptionPayload {
	message?: string;
}

function extractExceptionEvent(
	event: Record<string, unknown>
): { type: StreamExceptionEvent; payload: BedrockExceptionPayload } | undefined {
	for (const t of STREAM_EXCEPTION_EVENTS) {
		const payload = event[t];
		if (payload) {
			return { type: t, payload: payload as BedrockExceptionPayload };
		}
	}
	return undefined;
}

export class StreamProcessor {
	private toolBuffer: ToolCallBufferManager;

	constructor() {
		this.toolBuffer = new ToolCallBufferManager();
	}

	async processStream(
		stream: AsyncIterable<any>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		this.toolBuffer.reset();

		try {
			for await (const event of stream) {
				if (token.isCancellationRequested) {
					break;
				}

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

					if (delta?.text) {
						progress.report(new vscode.LanguageModelTextPart(delta.text));
						if (delta.text.length > 0) {
							this.toolBuffer.markHasText();
						}
					}

					if (delta?.toolUse?.input) {
						this.toolBuffer.appendArgs(idx, delta.toolUse.input);
						await this.toolBuffer.tryEmit(idx, progress);
					}
				} else if (event.contentBlockStop) {
					const idx = event.contentBlockStop.contentBlockIndex ?? 0;
					await this.toolBuffer.tryEmit(idx, progress, true);
				} else if (event.messageStop) {
					await this.toolBuffer.emitAll(progress, event.messageStop.stopReason);
				} else if (event.messageStart || event.metadata) {
					// messageStart carries only role; metadata carries token usage. Nothing
					// to emit downstream today, but log so future work can wire them up
					// without first having to discover they exist.
					if (event.metadata) {
						logger.log("[StreamProcessor] metadata", {
							usage: event.metadata.usage,
							metrics: event.metadata.metrics,
						});
					}
				} else {
					const exception = extractExceptionEvent(event as Record<string, unknown>);
					if (exception) {
						const message = exception.payload?.message ?? "unknown error";
						logger.error("[StreamProcessor] Bedrock stream exception", {
							type: exception.type,
							message,
						});
						progress.report(
							new vscode.LanguageModelTextPart(
								`\n[Bedrock] ${exception.type}: ${message}`
							)
						);
						// Abort the turn. The outer catch preserves cancellation semantics
						// (suppressed when token.isCancellationRequested), so this surfaces
						// only when the user has not cancelled.
						throw new Error(`Bedrock stream ${exception.type}: ${message}`);
					} else {
						logger.warn("[StreamProcessor] Unhandled event type", {
							keys: Object.keys(event),
						});
					}
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
}
