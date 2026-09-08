import * as vscode from "vscode";
import type { ToolCallBuffer, ToolCallFailure } from "./types";
import { tryParseJSONObject } from "./converters/schema";
import { logger } from "./logger";

/**
 * Accumulates the fragments of a tool call's JSON arguments as they stream in and
 * emits a LanguageModelToolCallPart once they parse.
 *
 * Lifetime matters: one instance per response stream. VS Code runs chat requests
 * concurrently (an agent turn alongside a title/summary request, say), and a
 * ToolCallBufferManager shared between them corrupts both — whichever request
 * starts second calls reset() and wipes the arguments the first is still
 * accumulating. That is what produced the reported
 * `Invalid JSON for tool call { "index": 0, "snippet": "" }`: an empty snippet
 * means the buffer was cleared out from under a live stream, not that the model
 * sent nothing. StreamProcessor now builds one of these per processStream call.
 */
export class ToolCallBufferManager {
	private buffers = new Map<number, ToolCallBuffer>();
	private completedIndices = new Set<number>();
	private emittedToolUseIds = new Set<string>();
	private failures: ToolCallFailure[] = [];
	private emittedIds: string[] = [];
	private hasText = false;
	private firstTool = true;

	reset(): void {
		this.buffers.clear();
		this.completedIndices.clear();
		this.emittedToolUseIds.clear();
		this.failures = [];
		this.emittedIds = [];
		this.hasText = false;
		this.firstTool = true;
	}

	startToolCall(index: number, toolUseId: string, name: string): void {
		// A fresh block at this index supersedes anything recorded for it before.
		this.completedIndices.delete(index);
		const existing = this.buffers.get(index);
		this.buffers.set(index, {
			id: toolUseId,
			name,
			// Deltas can technically precede contentBlockStart; keep whatever arrived.
			args: existing?.args ?? "",
		});
	}

	/**
	 * Append a fragment of the tool's JSON arguments.
	 *
	 * Bedrock documents `delta.toolUse.input` as a string, but some model families
	 * hand back an already-parsed object instead. Stringify those so the
	 * accumulate-then-parse path still works rather than appending "[object Object]".
	 */
	appendArgs(index: number, input: unknown): void {
		if (input === undefined || input === null) {
			return;
		}

		let fragment: string;
		if (typeof input === "string") {
			fragment = input;
		} else if (typeof input === "object") {
			try {
				fragment = JSON.stringify(input);
			} catch {
				logger.warn("[Tool Buffer] Dropped unserializable tool input fragment", { index });
				return;
			}
		} else {
			fragment = String(input);
		}

		// Tolerate deltas that arrive before contentBlockStart: create the buffer
		// unnamed and let tryEmit wait for the name.
		const buf = this.buffers.get(index) ?? { args: "" };
		buf.args += fragment;
		this.buffers.set(index, buf);
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

	/** Tool calls whose arguments never parsed. Empty on a healthy stream. */
	getFailures(): readonly ToolCallFailure[] {
		return this.failures;
	}

	/** IDs of the tool calls emitted so far, in emission order. */
	getEmittedIds(): readonly string[] {
		return this.emittedIds;
	}

	async tryEmit(
		index: number,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		force = false
	): Promise<void> {
		const buf = this.buffers.get(index);
		if (!buf || this.completedIndices.has(index)) {
			return;
		}

		if (!buf.name) {
			// Without a name there is nothing callable. Only give up once the block
			// is closed, so an out-of-order delta still gets its name.
			if (force) {
				this.recordFailure(index, buf, "tool call arrived without a name");
			}
			return;
		}

		const raw = buf.args;

		// A tool whose schema declares no parameters produces no input deltas at
		// all, leaving args as "". That is a complete zero-argument call, not a
		// broken one — but only conclude that once the block is closed, otherwise
		// every tool call would fire before its first delta.
		if (raw.trim().length === 0) {
			if (force) {
				this.emit(index, buf, {}, progress);
			}
			return;
		}

		const canParse = tryParseJSONObject(raw);

		// Early emission: emit as soon as the accumulated JSON becomes valid.
		if (canParse.ok) {
			this.emit(index, buf, canParse.value, progress);
			return;
		}

		if (force) {
			this.recordFailure(index, buf, "arguments never formed valid JSON");
		}
	}

	async emitAll(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		for (const [idx] of Array.from(this.buffers.entries())) {
			await this.tryEmit(idx, progress, true);
		}
	}

	private emit(
		index: number,
		buf: ToolCallBuffer,
		parameters: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): void {
		const name = buf.name ?? "";
		const id = buf.id && buf.id.length > 0 ? buf.id : `call_${Math.random().toString(36).slice(2, 10)}`;

		// Deduplicate on toolUseId, which Bedrock guarantees unique per call. The
		// previous content-based key also swallowed legitimate repeat calls — a
		// model asking to read the same file twice in one turn, for instance.
		if (this.emittedToolUseIds.has(id)) {
			logger.log("[Tool Buffer] Skipping duplicate tool call", { name, toolUseId: id });
			this.finish(index);
			return;
		}

		this.emittedToolUseIds.add(id);
		this.emittedIds.push(id);
		try {
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parameters));
		} catch (e) {
			logger.error("[Tool Buffer] Failed to report tool call", { name, toolUseId: id, error: e });
		}
		this.finish(index);
	}

	/**
	 * Give up on a tool call. Marking the index complete is what stops the same
	 * failure being logged twice — contentBlockStop forces an emit and messageStop
	 * then forces another over whatever is left, which is why the original report
	 * showed each error duplicated.
	 */
	private recordFailure(index: number, buf: ToolCallBuffer, reason: string): void {
		const args = buf.args || "";
		const failure: ToolCallFailure = {
			index,
			toolUseId: buf.id,
			name: buf.name,
			argsLength: args.length,
			snippet: args.slice(0, 200),
		};
		this.failures.push(failure);
		logger.error("[Tool Buffer] Invalid JSON for tool call", { reason, ...failure });
		this.finish(index);
	}

	private finish(index: number): void {
		this.buffers.delete(index);
		this.completedIndices.add(index);
	}
}
