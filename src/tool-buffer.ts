import * as vscode from "vscode";
import type { ToolCallBuffer } from "./types";
import { tryParseJSONObject } from "./converters/schema";
import { logger } from "./logger";

export class ToolCallBufferManager {
	private buffers: Map<number, ToolCallBuffer> = new Map();
	private completedIndices = new Set<number>();
	private emittedToolCallKeys = new Set<string>();
	private hasText: boolean = false;
	private firstTool: boolean = true;

	reset(): void {
		this.buffers.clear();
		this.completedIndices.clear();
		this.emittedToolCallKeys.clear();
		this.hasText = false;
		this.firstTool = true;
	}

	startToolCall(index: number, toolUseId: string, name: string): void {
		this.buffers.set(index, {
			id: toolUseId,
			name,
			args: "",
		});
	}

	appendArgs(index: number, input: string): void {
		const buf = this.buffers.get(index);
		if (buf) {
			buf.args += input;
			this.buffers.set(index, buf);
		}
	}

	markHasText(): void {
		this.hasText = true;
	}

	shouldAddSpaceBeforeFirstTool(): boolean {
		return this.hasText && this.firstTool;
	}

	markFirstToolEmitted(): void {
		this.firstTool = false;
	}

	async tryEmit(
		index: number,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		force: boolean = false,
		stopReason?: string
	): Promise<void> {
		const buf = this.buffers.get(index);
		if (!buf || this.completedIndices.has(index)) {
			return;
		}

		if (!buf.name) {
			return;
		}

		const rawArgs = (buf.args ?? "").trim();

		// A truly parameterless tool call is only safe to emit as {} once the model
		// has signaled stopReason=tool_use: Bedrock also produces an empty buffer
		// when max_tokens truncates before the first input delta, and executing a
		// truncated create_file (etc.) with no args is unsafe.
		const allowEmpty = force && rawArgs === "" && stopReason === "tool_use";
		const canParse = allowEmpty
			? ({ ok: true as const, value: {} as Record<string, unknown> })
			: tryParseJSONObject(buf.args);

		// Early emission: emit as soon as JSON becomes valid
		if (canParse.ok) {
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const parameters = canParse.value;

			// Content-based deduplication
			const canonical = JSON.stringify(parameters);
			const key = `${buf.name}:${canonical}`;

			if (this.emittedToolCallKeys.has(key)) {
				logger.log("[Tool Buffer] Skipping duplicate tool call", { name: buf.name, key });
				this.buffers.delete(index);
				this.completedIndices.add(index);
				return;
			}

			this.emittedToolCallKeys.add(key);
			progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
			this.buffers.delete(index);
			this.completedIndices.add(index);
			return;
		}

		if (!force) {
			return;
		}

		// Force path with no parse. If the buffer is empty and we have no stopReason
		// yet (contentBlockStop calls tryEmit before messageStop arrives), defer
		// without logging — messageStop will call emitAll with the stopReason and
		// this branch will decide then. Prevents the same failure being logged twice.
		if (rawArgs === "" && stopReason === undefined) {
			return;
		}

		logger.error("[Tool Buffer] Invalid JSON for tool call", {
			index,
			name: buf.name,
			length: buf.args.length,
			stopReason: stopReason ?? "unknown",
			snippet: (buf.args || "").slice(0, 200),
		});

		// Surface the failure to the user — without a text part, VS Code sees an
		// assistant turn with no actionable content and the agent loop exits with
		// no explanation. Keep the message short and non-alarming.
		const reasonSuffix = stopReason ? ` (stopReason: ${stopReason})` : "";
		progress.report(
			new vscode.LanguageModelTextPart(
				`\n[Bedrock] Tool call \`${buf.name}\` could not be parsed${reasonSuffix}.`
			)
		);

		// Mark the index done so messageStop -> emitAll doesn't re-log or re-report
		// the same failure. Without this, the same error surfaces twice.
		this.buffers.delete(index);
		this.completedIndices.add(index);
	}

	async emitAll(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		stopReason?: string
	): Promise<void> {
		for (const [idx] of Array.from(this.buffers.entries())) {
			await this.tryEmit(idx, progress, true, stopReason);
		}
	}
}
