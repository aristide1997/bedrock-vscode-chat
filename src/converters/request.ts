import type { LanguageModelChatInformation, LanguageModelChatRequestHandleOptions } from "vscode";
import { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ModelProfile } from "../profiles";

export type ReasoningEffort = 'max' | 'xhigh' | 'high' | 'medium' | 'low';

/**
 * Options controlling extended thinking / reasoning for the request.
 */
export interface ThinkingOptions {
	/** Whether the user has thinking enabled (subject to profile.supportsThinking). */
	enabled: boolean;
	/** Effort level used to derive the token budget when no explicit budget is set. */
	effort: ReasoningEffort;
	/** Explicit budget override; when set it wins over the effort-derived value. */
	budgetTokens?: number;
}

/**
 * Derive a thinking token budget from an effort level, clamped so it always
 * leaves room for the answer. Bedrock requires budget_tokens < max_tokens and
 * budget_tokens >= 1024 for Anthropic reasoning.
 *
 * NOTE: Only used for the LEGACY fixed-budget reasoning API (Claude 3.7 / 4.0).
 * Newer models (Opus 4.1+/Sonnet 4.5+) use the adaptive `output_config.effort`
 * API where the model chooses its own budget, so this table does not apply.
 */
export function budgetForEffort(effort: ReasoningEffort, maxTokens: number): number {
	const ceilings: Record<ReasoningEffort, number> = {
		max: 60000,
		xhigh: 48000,
		high: 32000,
		medium: 16000,
		low: 4000,
	};
	const target = ceilings[effort] ?? ceilings.max;
	// Keep at least 1024 tokens for the visible answer, and stay under max_tokens.
	const upperBound = Math.max(1024, maxTokens - 1024);
	return Math.max(1024, Math.min(target, upperBound));
}

/**
 * Build the Bedrock ConverseStream request from already-converted pieces.
 *
 * Pure function (no I/O) so the inferenceConfig assembly — temperature omission
 * for models that deprecated it, topP, stopSequences — is unit-testable without
 * a live Bedrock call. Mirrors the request shape the handler previously built inline.
 */
export function buildRequestInput(params: {
	model: Pick<LanguageModelChatInformation, "id" | "maxOutputTokens">;
	converted: { messages: unknown[]; system: unknown[] };
	options: LanguageModelChatRequestHandleOptions;
	profile: ModelProfile;
	toolConfig: unknown;
	thinking?: ThinkingOptions;
}): ConverseStreamCommandInput {
	const { model, converted, options, profile, toolConfig, thinking } = params;

	const requestInput: ConverseStreamCommandInput = {
		modelId: model.id,
		messages: converted.messages as any,
		inferenceConfig: {
			maxTokens: Math.min(options.modelOptions?.max_tokens || 4096, model.maxOutputTokens),
			// Temperature must be omitted for models that have deprecated it (e.g. Claude 4+)
			...(profile.supportsTemperature && {
				temperature: options.modelOptions?.temperature ?? 0.7,
			}),
		},
	};

	if (converted.system.length > 0) {
		requestInput.system = converted.system as any;
	}

	if (options.modelOptions) {
		const mo = options.modelOptions as Record<string, unknown>;
		if (typeof mo.top_p === "number") {
			requestInput.inferenceConfig!.topP = mo.top_p;
		}
		if (typeof mo.stop === "string") {
			requestInput.inferenceConfig!.stopSequences = [mo.stop];
		} else if (Array.isArray(mo.stop)) {
			requestInput.inferenceConfig!.stopSequences = mo.stop;
		}
	}

	if (toolConfig) {
		requestInput.toolConfig = toolConfig as any;
	}

	// Extended thinking / reasoning (Anthropic on Bedrock).
	// Only applied when the model profile supports it and the user enabled it.
	if (thinking?.enabled && profile.supportsThinking && profile.reasoningApi !== 'none') {
		// Reasoning requires temperature and topP to be omitted.
		delete requestInput.inferenceConfig!.temperature;
		delete requestInput.inferenceConfig!.topP;

		const additional =
			(requestInput.additionalModelRequestFields as Record<string, unknown>) ?? {};

		if (profile.reasoningApi === 'effort') {
			// Adaptive API (Claude 4.6+, e.g. Opus 4.8 / Sonnet 4.6): the model decides
			// dynamically when and how much to think, controlled by the effort level.
			// This is the recommended mode — `thinking: { type: "adaptive" }` combined
			// with `output_config: { effort }`. No budget_tokens, no max_tokens bump.
			// Mirrors Claude Code's request for these models.
			//
			// `display: "summarized"` is REQUIRED to receive visible reasoning text:
			// on Opus 4.8/4.7 `display` defaults to "omitted", which streams only an
			// empty thinking block + signature (no readable summary). We opt in so the
			// reasoning actually appears in the chat UI.
			requestInput.additionalModelRequestFields = {
				...additional,
				thinking: {
					type: "adaptive",
					display: "summarized",
				},
				output_config: {
					effort: thinking.effort,
				},
			};
		} else {
			// Legacy fixed-budget API (Claude 3.7 / 4.0): we must compute a budget and
			// ensure max_tokens leaves room for both the reasoning budget and the answer.
			const baseMax = requestInput.inferenceConfig!.maxTokens ?? 4096;
			const budget = thinking.budgetTokens ?? budgetForEffort(thinking.effort, baseMax);
			requestInput.inferenceConfig!.maxTokens = Math.min(
				model.maxOutputTokens,
				Math.max(baseMax, budget + 8192)
			);
			requestInput.additionalModelRequestFields = {
				...additional,
				reasoning_config: {
					type: "enabled",
					budget_tokens: budget,
				},
			};
		}
	}

	return requestInput;
}
