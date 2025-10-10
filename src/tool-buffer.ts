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

		// Only log error when forced and JSON is still invalid
		if (force && !canParse.ok) {
			logger.error("[Tool Buffer] Invalid JSON for tool call", {
				index,
				snippet: (buf.args || "").slice(0, 200),
			});
		}
	}

	async emitAll(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		for (const [idx] of Array.from(this.buffers.entries())) {
			await this.tryEmit(idx, progress, true);
		}
	}
}
