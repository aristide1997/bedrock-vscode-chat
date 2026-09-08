import type { ThinkingEffort } from "./converters/request";
import {
	budgetForEffort,
	minMaxTokensForEffort,
	resolveMaxTokens,
	MIN_THINKING_BUDGET,
	MIN_ANSWER_TOKENS,
} from "./converters/request";
import { THINKING_EFFORTS } from "./thinking-variants";

/** Whether an effort level can actually be used with the current limits. */
export type EffortFit = "fits" | "tight" | "impossible";

export interface EffortAvailability {
	effort: ThinkingEffort;
	fit: EffortFit;
	/** Reasoning budget this level asks for. */
	budget: number;
	/** Output limit this level needs, budget plus an answer allowance. */
	required: number;
	/** Output limit that would actually be sent. */
	resolved: number;
	/** The model's own ceiling. */
	ceiling: number;
	/** True when an explicit `maxOutputTokens` setting is what constrains it. */
	limitedBySetting: boolean;
	/**
	 * Effort that would actually be sent. Lower than `effort` on the adaptive API
	 * when the limit cannot accommodate the requested level.
	 */
	effectiveEffort?: ThinkingEffort;
	/** Which thinking API the assessment assumed. */
	api: "budget" | "adaptive";
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Work out, for one model, whether each effort level is usable.
 *
 * Exists so the quick pick can mark a level that cannot work *before* it is
 * picked. Reporting the conflict at request time is strictly worse: the user has
 * already written a prompt, waited, and lost the turn. This makes the same
 * arithmetic available up front.
 *
 * Deliberately reuses {@link resolveMaxTokens} rather than reimplementing the
 * rules. A second copy of the precedence logic would be a new place for the
 * settings UI to disagree with what actually gets sent, which is the class of
 * bug this whole area already suffered from.
 */
export function assessEffort(params: {
	effort: ThinkingEffort;
	/** The model's output ceiling. */
	ceiling: number;
	/** The `maxOutputTokens` setting, undefined when unset. */
	settingMaxTokens?: number;
	/** Explicit thinking budget, undefined to derive from the effort. */
	budgetTokens?: number;
	/** Which thinking API the model uses. */
	api?: "budget" | "adaptive";
}): EffortAvailability {
	const { effort, ceiling } = params;
	const api = params.api ?? "adaptive";

	const resolution = resolveMaxTokens({
		modelCeiling: ceiling,
		settingMaxTokens: params.settingMaxTokens,
		thinking: { api, effort, budgetTokens: params.budgetTokens },
	});

	const budget =
		api === "budget" && params.budgetTokens && params.budgetTokens > 0
			? Math.max(MIN_THINKING_BUDGET, params.budgetTokens)
			: budgetForEffort(effort);
	const required = minMaxTokensForEffort(effort);

	let fit: EffortFit;
	if (resolution.conflict || !resolution.thinkingFits) {
		fit = "impossible";
	} else if (resolution.maxTokens < required) {
		// Usable, but not as asked: on the budget API the budget is shrunk, and on
		// the adaptive API the effort itself is reduced, because its budget is
		// derived server-side and cannot be constrained any other way.
		fit = "tight";
	} else {
		fit = "fits";
	}

	return {
		effort,
		fit,
		budget,
		required,
		resolved: resolution.maxTokens,
		ceiling,
		limitedBySetting: resolution.source === "setting",
		effectiveEffort: resolution.effort,
		api,
	};
}

/** Assess every effort level against the same model and settings. */
export function assessAllEfforts(params: Omit<Parameters<typeof assessEffort>[0], "effort">): EffortAvailability[] {
	return THINKING_EFFORTS.map((effort) => assessEffort({ ...params, effort }));
}

/**
 * The description shown against an effort level in the quick pick.
 *
 * Says what the level costs *and* whether it will work here, because the token
 * budget alone was the misleading part: it looked like a free choice when an
 * explicit output cap could make it unusable.
 */
export function describeAvailability(a: EffortAvailability): string {
	const budget = `${n(a.budget)}-token budget`;
	switch (a.fit) {
		case "fits":
			return budget;
		case "tight":
			// On the adaptive API the effort itself is what gets reduced, so name the
			// level that would actually be used rather than implying this one runs.
			return a.api === "adaptive" && a.effectiveEffort && a.effectiveEffort !== a.effort
				? `${budget} — would run as "${a.effectiveEffort}"; only ${n(a.resolved)} output tokens available`
				: `${budget} — only ${n(a.resolved)} output tokens available`;
		case "impossible":
			return `${budget} — needs ${n(a.required)} output tokens, only ${n(a.resolved)} available`;
	}
}

/** The longer explanation shown under a level that cannot or barely fits. */
export function detailForAvailability(a: EffortAvailability): string | undefined {
	if (a.fit === "fits") {
		return undefined;
	}

	const cause = a.limitedBySetting
		? `"maxOutputTokens" is set to ${n(a.resolved)}`
		: `this model allows only ${n(a.ceiling)} output tokens`;

	if (a.fit === "impossible") {
		const remedy = a.limitedBySetting
			? a.required <= a.ceiling
				? `Set it to 0 to use the model's maximum of ${n(a.ceiling)}, or raise it to ${n(a.required)}.`
				: `Even the model's maximum of ${n(a.ceiling)} cannot fit this level.`
			: `Pick a lower level for this model.`;
		return `$(error) Not usable: ${cause}, and reasoning needs at least ${n(
			MIN_THINKING_BUDGET + MIN_ANSWER_TOKENS
		)}. ${remedy}`;
	}

	// The adaptive API derives its budget from the effort level, so the level
	// itself is lowered rather than a budget trimmed. Say which level will run.
	if (a.api === "adaptive" && a.effectiveEffort && a.effectiveEffort !== a.effort) {
		return (
			`$(warning) Would run as "${a.effectiveEffort}" instead: ${cause}, below the ` +
			`${n(a.required)} this level needs. This model derives its reasoning budget from the ` +
			`effort level, so the level is lowered rather than the budget trimmed.`
		);
	}

	return `$(warning) Reasoning will be cut short: ${cause}, below the ${n(a.required)} this level wants.`;
}

/** Icon marking a level's fit in the quick pick, or undefined when it is fine. */
export function iconForAvailability(a: EffortAvailability): string | undefined {
	if (a.fit === "impossible") {
		return "error";
	}
	if (a.fit === "tight") {
		return "warning";
	}
	return undefined;
}
