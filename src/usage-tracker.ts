import type { BedrockUsage } from "./types";
import { logger } from "./logger";

export interface TurnUsage {
	modelId: string;
	stopReason?: string;
	usage?: BedrockUsage;
	latencyMs?: number;
	/** Our pre-flight estimate, so drift against Bedrock's count is visible. */
	estimatedInputTokens?: number;
	/** Source of the pre-flight count: Bedrock's own tokenizer, or our heuristic. */
	estimateSource?: "native" | "heuristic";
	maxInputTokens: number;
	maxOutputTokens: number;
	emittedToolCalls: number;
	cachePoints: number;
	thinkingEnabled: boolean;
}

export interface SessionTotals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheWriteInputTokens: number;
}

/**
 * Records what each turn actually cost and writes it to the output channel.
 *
 * The reported problem was that nothing anywhere logged model turns, token usage
 * or context size, so there was no way to tell how full the context window was
 * or whether caching was working. Bedrock returns all of it on the stream's
 * `metadata` event, which the provider previously ignored entirely.
 *
 * Note the ceiling on how far this can go: the finalized language-model provider
 * API gives a provider no channel for feeding usage back into Copilot's own
 * request log or its context-window indicator. Copilot derives that display from
 * `provideTokenCount`, which is why that path now counts every part type and
 * prefers Bedrock's native tokenizer. Everything else lands in the "Bedrock
 * Chat" output channel.
 */
export class UsageTracker {
	private totals: SessionTotals = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheWriteInputTokens: 0,
	};

	getTotals(): SessionTotals {
		return { ...this.totals };
	}

	reset(): void {
		this.totals = {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheWriteInputTokens: 0,
		};
	}

	record(turn: TurnUsage): void {
		const u = turn.usage;
		this.totals.turns++;
		this.totals.inputTokens += u?.inputTokens ?? 0;
		this.totals.outputTokens += u?.outputTokens ?? 0;
		this.totals.cacheReadInputTokens += u?.cacheReadInputTokens ?? 0;
		this.totals.cacheWriteInputTokens += u?.cacheWriteInputTokens ?? 0;

		const inputTokens = u?.inputTokens;
		const contextUsedPct =
			inputTokens !== undefined && turn.maxInputTokens > 0
				? Math.round((inputTokens / turn.maxInputTokens) * 1000) / 10
				: undefined;

		logger.log("[Usage] Turn complete", {
			model: turn.modelId,
			stopReason: turn.stopReason,
			inputTokens,
			outputTokens: u?.outputTokens,
			totalTokens: u?.totalTokens,
			cacheReadInputTokens: u?.cacheReadInputTokens,
			cacheWriteInputTokens: u?.cacheWriteInputTokens,
			contextWindow: `${inputTokens ?? "?"}/${turn.maxInputTokens}${
				contextUsedPct !== undefined ? ` (${contextUsedPct}%)` : ""
			}`,
			maxOutputTokens: turn.maxOutputTokens,
			latencyMs: turn.latencyMs,
			toolCalls: turn.emittedToolCalls,
			cachePoints: turn.cachePoints,
			thinking: turn.thinkingEnabled,
			preflightEstimate: turn.estimatedInputTokens,
			preflightSource: turn.estimateSource,
		});

		logger.log("[Usage] Session totals", this.totals);

		// A cache checkpoint that never reads back is pure overhead, so say so
		// once rather than leaving the user to infer it from the numbers.
		if (turn.cachePoints > 0 && (u?.cacheReadInputTokens ?? 0) === 0 && (u?.cacheWriteInputTokens ?? 0) === 0) {
			logger.warn(
				"[Usage] Prompt caching was requested but Bedrock reported no cache activity. " +
					"The prefix is probably below the model's minimum cacheable size."
			);
		}

		if (contextUsedPct !== undefined && contextUsedPct >= 90) {
			logger.warn(`[Usage] Context window ${contextUsedPct}% full`, {
				inputTokens,
				maxInputTokens: turn.maxInputTokens,
			});
		}
	}
}
