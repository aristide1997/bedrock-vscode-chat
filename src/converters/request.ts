import type { LanguageModelChatInformation, LanguageModelChatRequestHandleOptions } from "vscode";
import { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ModelProfile, ThinkingApi } from "../profiles";
import type { BedrockMessage, BedrockSystemBlock, BedrockToolConfig } from "../types";
import { applyCachePoints } from "./cache-points";

/** Effort levels accepted by the adaptive thinking API. */
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh";

export interface ThinkingSettings {
	enabled: boolean;
	effort: ThinkingEffort;
	/**
	 * Token budget for models on the legacy budget API. `undefined` (or a
	 * non-positive number) means "derive it from the effort level".
	 */
	budgetTokens?: number;
}

/**
 * Token budget to request from a legacy (pre-adaptive) thinking model for a
 * given effort level. Anthropic requires at least 1024 and the budget must stay
 * below maxTokens, which {@link resolveMaxTokens} guarantees.
 */
export function budgetForEffort(effort: ThinkingEffort): number {
	switch (effort) {
		case "low":
			return 2048;
		case "medium":
			return 8192;
		case "high":
			return 16384;
		case "xhigh":
			return 32768;
	}
}

/** Anthropic's documented floor for a thinking token budget. */
export const MIN_THINKING_BUDGET = 1024;

/**
 * Output tokens held back for the visible answer on top of the thinking budget.
 *
 * Extended thinking is paid for out of `maxTokens`, so a budget of
 * `maxTokens - 1` leaves the model a single token to answer in. Reserve a real
 * allowance instead.
 */
export const PREFERRED_ANSWER_TOKENS = 4096;

/**
 * Absolute minimum headroom above the thinking budget. Below this the model has
 * nowhere to put an answer, so thinking is dropped rather than sent.
 */
export const MIN_ANSWER_TOKENS = 1024;

/** Used only when a model reports no usable output ceiling whatsoever. */
export const LAST_RESORT_MAX_OUTPUT_TOKENS = 4096;

/**
 * The `maxTokens` extended thinking needs at a given effort level: the budget
 * the model is expected to spend, plus room to answer afterwards.
 *
 * Derived from {@link budgetForEffort} rather than tabulated separately so the
 * two cannot drift apart. Applies to the adaptive API too: the model picks its
 * own budget there, but it picks it from the same effort level, so the same
 * headroom is required.
 */
export function minMaxTokensForEffort(effort: ThinkingEffort): number {
	return budgetForEffort(effort) + PREFERRED_ANSWER_TOKENS;
}

/**
 * The highest effort level whose derived budget fits inside `maxTokens`, never
 * exceeding `requested`, or `undefined` when even the lowest does not fit.
 *
 * Needed because the adaptive API gives no way to constrain the budget: the
 * request carries only `output_config.effort` and the service picks the budget
 * from it, so a `max_tokens` smaller than that budget cannot be reconciled by
 * shrinking anything. The only lever left is the effort itself.
 *
 * Capped at `requested` because this is a fitting mechanism, not an optimizer:
 * silently spending more on reasoning than the user asked for would be a
 * surprise, and a costly one.
 */
export function highestEffortFitting(
	maxTokens: number,
	requested: ThinkingEffort
): ThinkingEffort | undefined {
	const cap = EFFORTS_ASCENDING.indexOf(requested);
	// Descending from the requested level, so the best level that fits is chosen
	// rather than the first, and never one above what was asked for.
	for (let i = cap; i >= 0; i--) {
		const effort = EFFORTS_ASCENDING[i];
		if (maxTokens >= minMaxTokensForEffort(effort)) {
			return effort;
		}
	}
	return undefined;
}

/** Effort levels in ascending order of cost. Local, to avoid an import cycle. */
const EFFORTS_ASCENDING: readonly ThinkingEffort[] = ["low", "medium", "high", "xhigh"];

/** Where the requested output-token cap came from. */
export type MaxTokensSource = "request" | "setting" | "model-ceiling";

/**
 * An output-token cap that was explicitly asked for but cannot accommodate the
 * requested thinking effort. Reported rather than silently overridden, because
 * quietly ignoring an explicit cap is its own bug.
 */
export interface ThinkingBudgetConflict {
	/** The cap that was asked for. */
	maxTokens: number;
	/** The cap extended thinking needs at this effort. */
	requiredMaxTokens: number;
	effort: ThinkingEffort;
	/** Which explicit input set the cap. */
	source: "request" | "setting";
	/** The model's own ceiling, so the message can say whether it would fit. */
	ceiling: number;
}

export interface MaxTokensResolution {
	/** The value to send. */
	maxTokens: number;
	/** Which input won. */
	source: MaxTokensSource;
	/** The model's output ceiling actually used. */
	ceiling: number;
	/** True when the winning input exceeded the model ceiling. */
	clampedToCeiling: boolean;
	/** Effort-derived floor aimed for, when thinking was requested. */
	thinkingFloor?: number;
	/** Budget to send for models on the legacy budget API. */
	budgetTokens?: number;
	/**
	 * Effort to actually send, which may be lower than the one requested when
	 * `maxTokens` cannot accommodate the requested level's budget.
	 */
	effort?: ThinkingEffort;
	/** Set when the effort was reduced to fit, so the caller can say so. */
	effortDowngradedFrom?: ThinkingEffort;
	/** False when thinking cannot fit and must be dropped for this request. */
	thinkingFits: boolean;
	/** Set when an explicit cap is too small for the requested effort. */
	conflict?: ThinkingBudgetConflict;
}

/**
 * Work out the output-token cap to send, and reconcile it with extended
 * thinking.
 *
 * Split out of {@link buildRequestInput} because this is where two separate
 * production failures lived and both are worth pinning down by test:
 *
 * 1. `0` is the documented "use the model maximum" sentinel for the
 *    `maxOutputTokens` setting, but `??` only falls through on `null` and
 *    `undefined`. A literal `0` therefore won the precedence chain and every
 *    request Copilot did not attach its own `max_tokens` to was capped at one
 *    output token.
 * 2. The thinking budget was only ever clamped *down* to fit `maxTokens`, which
 *    is impossible below Anthropic's 1024-token floor. When `maxTokens` was
 *    small the request went out with `max_tokens <= thinking.budget_tokens` and
 *    was rejected. The cap has to move up to meet the budget, not the reverse.
 */
export function resolveMaxTokens(params: {
	/** The model's reported output ceiling. Non-positive values are ignored. */
	modelCeiling: number | undefined;
	/** Ceiling to fall back to when the model reports none. */
	fallbackCeiling?: number;
	/** `modelOptions.max_tokens` from the caller, if any. */
	requestMaxTokens?: number;
	/** The `maxOutputTokens` setting, where 0/undefined means "unset". */
	settingMaxTokens?: number;
	/** Present only when extended thinking was asked for and is supported. */
	thinking?: { api: Exclude<ThinkingApi, "none">; effort: ThinkingEffort; budgetTokens?: number };
}): MaxTokensResolution {
	const ceiling =
		positive(params.modelCeiling) ??
		positive(params.fallbackCeiling) ??
		LAST_RESORT_MAX_OUTPUT_TOKENS;

	const requested = positive(params.requestMaxTokens);
	const setting = positive(params.settingMaxTokens);
	const source: MaxTokensSource =
		requested !== undefined ? "request" : setting !== undefined ? "setting" : "model-ceiling";
	const winning = requested ?? setting ?? ceiling;

	const maxTokens = Math.max(1, Math.min(winning, ceiling));
	const clampedToCeiling = winning > ceiling;

	// When nobody chose a value, maxTokens is already the ceiling — the largest
	// value available — so there is nothing to raise it to and no floor to apply.
	// Only an explicit request or setting can produce a value small enough to be a
	// problem, and those are honoured rather than overridden (see below).
	if (!params.thinking) {
		return {
			maxTokens,
			source,
			ceiling,
			clampedToCeiling,
			thinkingFits: false,
		};
	}

	const { api, effort: requestedEffort } = params.thinking;

	// The two APIs differ in a way that matters here.
	//
	// `budget`: the request carries an explicit `budget_tokens`, so a small
	// `max_tokens` can be honoured by shrinking the budget to fit.
	//
	// `adaptive`: the request carries only `output_config.effort`, and the service
	// derives the budget from it. There is nothing to shrink, so the only way to
	// fit a small `max_tokens` is to ask for less effort. Sending the requested
	// effort anyway is what produced the reported failure:
	//   `max_tokens` must be greater than `thinking.budget_tokens`
	// Copilot supplies its own small `max_tokens` for utility calls (titles,
	// summaries), so this fires on a perfectly ordinary configuration.
	const fittingEffort =
		api === "adaptive" ? highestEffortFitting(maxTokens, requestedEffort) : requestedEffort;
	const effort = fittingEffort ?? requestedEffort;
	const effortDowngradedFrom =
		fittingEffort !== undefined && fittingEffort !== requestedEffort ? requestedEffort : undefined;

	// The budget the model is expected to spend, at the effort actually sent.
	const desiredBudget =
		api === "budget"
			? Math.max(MIN_THINKING_BUDGET, positive(params.thinking.budgetTokens) ?? budgetForEffort(effort))
			: budgetForEffort(effort);

	const thinkingFloor = desiredBudget + PREFERRED_ANSWER_TOKENS;
	// Below this the pair is invalid no matter how the budget is shuffled.
	const hardFloor = MIN_THINKING_BUDGET + MIN_ANSWER_TOKENS;

	let conflict: ThinkingBudgetConflict | undefined;

	// Note there is no "raise maxTokens to the thinking floor" case. When no
	// explicit cap was given, maxTokens is already the model ceiling, so there is
	// no headroom left to claim; when one was given, honouring it matters more
	// than making thinking fit, so a cap that cannot work is reported instead.
	// The fix for the original bug was to stop clamping the *budget* down below
	// Anthropic's floor, which the budget calculation below now guarantees.
	if (maxTokens < thinkingFloor && source !== "model-ceiling" && maxTokens < hardFloor) {
		// An explicit cap that cannot work at all. Surface it instead of silently
		// overriding the user, or silently dropping their thinking.
		conflict = {
			maxTokens,
			requiredMaxTokens: Math.min(minMaxTokensForEffort(requestedEffort), ceiling),
			effort: requestedEffort,
			source: source === "request" ? "request" : "setting",
			ceiling,
		};
	}

	// On the adaptive API a cap below even the lowest level's budget cannot be
	// made to work, so thinking has to be dropped rather than sent invalid.
	const adaptiveCannotFit = api === "adaptive" && fittingEffort === undefined;
	const thinkingFits = conflict === undefined && maxTokens >= hardFloor && !adaptiveCannotFit;

	// Fit the legacy budget inside whatever cap was settled on. Never below
	// Anthropic's floor, and always leaving the answer some room.
	const budgetTokens =
		api === "budget" && thinkingFits
			? Math.max(MIN_THINKING_BUDGET, Math.min(desiredBudget, maxTokens - MIN_ANSWER_TOKENS))
			: undefined;

	return {
		maxTokens,
		source,
		ceiling,
		clampedToCeiling,
		thinkingFloor,
		budgetTokens,
		effort: thinkingFits ? effort : undefined,
		effortDowngradedFrom: thinkingFits ? effortDowngradedFrom : undefined,
		thinkingFits,
		conflict,
	};
}

export interface BuildRequestResult {
	input: ConverseStreamCommandInput;
	/** True when extended thinking was actually enabled for this request. */
	thinkingEnabled: boolean;
	/** Number of prompt-cache checkpoints inserted. */
	cachePoints: number;
	/** Full trace of how maxTokens was decided, for logging and diagnostics. */
	maxTokens: MaxTokensResolution;
}

/**
 * Build the Bedrock ConverseStream request from already-converted pieces.
 *
 * Pure function (no I/O) so the inferenceConfig assembly — temperature omission
 * for models that deprecated it, the output-token cap, thinking configuration
 * and cache checkpoints — is unit-testable without a live Bedrock call.
 */
export function buildRequestInput(params: {
	model: Pick<LanguageModelChatInformation, "id" | "maxOutputTokens">;
	converted: { messages: BedrockMessage[]; system: BedrockSystemBlock[] };
	options: LanguageModelChatRequestHandleOptions;
	profile: ModelProfile;
	toolConfig?: BedrockToolConfig;
	/** User override for max output tokens. 0 or undefined means "use the model maximum". */
	maxOutputTokensOverride?: number;
	/** Ceiling to assume when the model itself reports none. */
	fallbackMaxOutputTokens?: number;
	thinking?: ThinkingSettings;
	promptCaching?: boolean;
}): BuildRequestResult {
	const { model, converted, options, profile, toolConfig, maxOutputTokensOverride, thinking } = params;

	const thinkingRequested = Boolean(thinking?.enabled) && profile.thinkingApi !== "none";

	// Output-token budget, and its reconciliation with the thinking budget.
	//
	// Two bugs lived here. The cap used to default to 4096, which capped modern
	// Claude models at an eighth of what they allow and truncated large tool
	// calls mid-JSON ("Invalid JSON for tool call"). The fix defaulted to the
	// model ceiling but read the setting with `??`, so the documented `0`
	// sentinel meaning "model maximum" won the chain and produced
	// `maxTokens: 1` — which then made every thinking request invalid, because
	// the budget cannot be smaller than Anthropic's 1024-token floor. Both are
	// now decided in one tested place.
	const resolution = resolveMaxTokens({
		modelCeiling: model.maxOutputTokens,
		fallbackCeiling: params.fallbackMaxOutputTokens,
		requestMaxTokens: numericOption(options.modelOptions?.max_tokens),
		settingMaxTokens: maxOutputTokensOverride,
		thinking:
			thinkingRequested && thinking
				? {
						api: profile.thinkingApi as Exclude<ThinkingApi, "none">,
						effort: thinking.effort,
						budgetTokens: thinking.budgetTokens,
					}
				: undefined,
	});

	const maxTokens = resolution.maxTokens;
	// A cap that cannot house a thinking budget would be rejected outright by
	// Bedrock, so thinking is dropped for this turn instead. The handler warns.
	const thinkingEnabled = thinkingRequested && resolution.thinkingFits;

	const cached = applyCachePoints(
		{ messages: converted.messages, system: converted.system, toolConfig },
		profile,
		Boolean(params.promptCaching)
	);

	const requestInput: ConverseStreamCommandInput = {
		modelId: model.id,
		messages: cached.messages as ConverseStreamCommandInput["messages"],
		inferenceConfig: {
			maxTokens,
			// Temperature must be omitted for models that have deprecated it (e.g. Claude 4+),
			// and also whenever extended thinking is on: Anthropic rejects any sampling
			// override alongside thinking.
			...(profile.supportsTemperature &&
				!thinkingEnabled && {
					temperature: numericOption(options.modelOptions?.temperature) ?? 0.7,
				}),
		},
	};

	if (cached.system.length > 0) {
		requestInput.system = cached.system as ConverseStreamCommandInput["system"];
	}

	if (options.modelOptions) {
		const mo = options.modelOptions as Record<string, unknown>;
		// topP is a sampling parameter, so it is subject to the same restriction
		// as temperature when thinking is active.
		if (typeof mo.top_p === "number" && !thinkingEnabled) {
			requestInput.inferenceConfig!.topP = mo.top_p;
		}
		if (typeof mo.stop === "string") {
			requestInput.inferenceConfig!.stopSequences = [mo.stop];
		} else if (Array.isArray(mo.stop)) {
			requestInput.inferenceConfig!.stopSequences = mo.stop.filter((s): s is string => typeof s === "string");
		}
	}

	if (cached.toolConfig) {
		const wireToolConfig = { ...cached.toolConfig } as BedrockToolConfig;
		// Thinking models must be free to reason before choosing a tool, so a
		// forced tool choice has to be relaxed to auto rather than sent as-is.
		if (thinkingEnabled && wireToolConfig.toolChoice && !wireToolConfig.toolChoice.auto) {
			wireToolConfig.toolChoice = { auto: {} };
		}
		requestInput.toolConfig = wireToolConfig as ConverseStreamCommandInput["toolConfig"];
	}

	if (thinkingEnabled && thinking) {
		// The resolved effort, not the requested one: on the adaptive API a small
		// maxTokens is accommodated by lowering the effort, since the budget is
		// derived from it server-side and cannot be constrained any other way.
		const effort = resolution.effort ?? thinking.effort;
		const existingFields = (requestInput.additionalModelRequestFields ?? {}) as Record<string, unknown>;
		if (profile.thinkingApi === "adaptive") {
			// Claude 4.6+ picks its own budget from a stated effort level. No budget
			// is sent, so the effort itself has to be one whose budget fits maxTokens.
			requestInput.additionalModelRequestFields = {
				...existingFields,
				thinking: { type: "adaptive" },
				output_config: { effort },
			};
		} else {
			// Legacy budget API. resolveMaxTokens has already fitted the budget
			// inside maxTokens while respecting Anthropic's 1024-token floor.
			requestInput.additionalModelRequestFields = {
				...existingFields,
				reasoning_config: {
					type: "enabled",
					budget_tokens: resolution.budgetTokens ?? MIN_THINKING_BUDGET,
				},
			};
		}
	}

	return { input: requestInput, thinkingEnabled, cachePoints: cached.inserted, maxTokens: resolution };
}

function positive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function numericOption(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
