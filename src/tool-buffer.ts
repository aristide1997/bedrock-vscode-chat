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
		force: boolean = false
	): Promise<void> {
		const buf = this.buffers.get(index);
		if (!buf || this.completedIndices.has(index)) {
			return;
		}

		if (!buf.name) {
			return;
		}

		const canParse = tryParseJSONObject(buf.args);

		// Early emission: emit as soon as JSON becomes valid
		if (canParse.ok) {
			this.emitToolCall(index, buf, canParse.value, progress);
			return;
		}

		// Forced finalization but JSON never became valid. This can happen with
		// arbitrary tool/hook output. Rather than silently dropping the tool call
		// (which can hang the agent loop) or crashing, emit it with best-effort
		// arguments: empty object if there were no args, otherwise log and skip.
		if (force) {
			const trimmed = (buf.args || "").trim();
			if (trimmed.length === 0) {
				this.emitToolCall(index, buf, {}, progress);
				return;
			}
			logger.error("[Tool Buffer] Invalid JSON for tool call; emitting with empty args", {
				index,
				snippet: trimmed.slice(0, 200),
			});
			this.emitToolCall(index, buf, {}, progress);
		}
	}

	/**
	 * Report a completed tool call to the chat UI. Never throws: a malformed or
	 * non-serializable parameter object must not crash the stream.
	 */
	private emitToolCall(
		index: number,
		buf: ToolCallBuffer,
		parameters: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): void {
		try {
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "";
			if (!name) {
				logger.error("[Tool Buffer] Cannot emit tool call without a name", { index });
				return;
			}

			// Content-based deduplication (tolerant of non-serializable params).
			let canonical: string;
			try {
				canonical = JSON.stringify(parameters);
			} catch {
				canonical = `${index}:${Math.random()}`;
			}
			const key = `${name}:${canonical}`;

			if (this.emittedToolCallKeys.has(key)) {
				logger.log("[Tool Buffer] Skipping duplicate tool call", { name });
				this.buffers.delete(index);
				this.completedIndices.add(index);
				return;
			}

			this.emittedToolCallKeys.add(key);
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parameters ?? {}));
		} catch (e) {
			logger.error("[Tool Buffer] Failed to report tool call", e);
		} finally {
			this.buffers.delete(index);
			this.completedIndices.add(index);
		}
	}

	async emitAll(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		for (const [idx] of Array.from(this.buffers.entries())) {
			await this.tryEmit(idx, progress, true);
		}
	}
}
