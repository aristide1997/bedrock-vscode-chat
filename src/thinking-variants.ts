import type { ThinkingEffort } from "./converters/request";
import { budgetForEffort } from "./converters/request";

/** Effort levels in ascending order, as offered in the UI. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Separator between a Bedrock model ID and an effort level encoded into it.
 *
 * The chat window has no API for a provider to contribute its own controls, so
 * the only way to make effort selectable per conversation is to expose each
 * level as its own entry in the model picker. VS Code treats the model ID as an
 * opaque string and remembers it per conversation, which is exactly the
 * behaviour wanted — but the ID is also what gets sent to Bedrock, so it has to
 * be decoded again before use.
 *
 * `#` is chosen because it cannot occur in a Bedrock model ID or an inference
 * profile ARN, so splitting is unambiguous and an ID that was never encoded is
 * returned untouched.
 */
export const VARIANT_SEPARATOR = "#think=";

/**
 * Suffix marking the variant that disables reasoning for one conversation.
 *
 * Not a member of {@link THINKING_EFFORTS}: "off" is the absence of an effort
 * level, not a level of its own, and letting it into that array would put it in
 * every quick pick, budget table and settings enum that iterates over efforts.
 */
export const OFF_VARIANT = "off";

/**
 * What a picked model says about reasoning for its conversation.
 * - a {@link ThinkingEffort}: use that level.
 * - `"off"`: disable reasoning, overriding the global default.
 * - `undefined`: inherit the global default.
 */
export type VariantSelection = ThinkingEffort | typeof OFF_VARIANT;

export interface DecodedModelId {
	/** The real Bedrock model ID, safe to send on the wire. */
	baseId: string;
	/**
	 * Reasoning choice baked into the picked model, if any. `undefined` means the
	 * conversation inherits the global default rather than overriding it.
	 */
	effort?: VariantSelection;
}

export function isThinkingEffort(value: string): value is ThinkingEffort {
	return (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** Whether a decoded selection is the explicit "no reasoning" choice. */
export function isOffSelection(value: VariantSelection | undefined): value is typeof OFF_VARIANT {
	return value === OFF_VARIANT;
}

/** Build the picker ID for one reasoning choice of a model. */
export function encodeVariantId(baseId: string, effort: VariantSelection): string {
	return `${baseId}${VARIANT_SEPARATOR}${effort}`;
}

/**
 * Split a picker ID back into the model to invoke and the effort to request.
 *
 * Deliberately total and forgiving: an unrecognized suffix degrades to the base
 * model with no override rather than throwing. A stale ID persisted by a
 * conversation from a newer build must still be invocable, and getting the
 * effort wrong is far less costly than failing the request outright.
 */
export function decodeVariantId(id: string): DecodedModelId {
	const at = id.indexOf(VARIANT_SEPARATOR);
	if (at === -1) {
		return { baseId: id };
	}

	const baseId = id.slice(0, at);
	if (!baseId) {
		// Nothing before the separator: not something this code produced.
		return { baseId: id };
	}

	const suffix = id.slice(at + VARIANT_SEPARATOR.length);
	if (suffix === OFF_VARIANT) {
		return { baseId, effort: OFF_VARIANT };
	}
	return isThinkingEffort(suffix) ? { baseId, effort: suffix } : { baseId };
}

/**
 * Resolve the effort to request for one turn.
 *
 * Precedence: a choice made in the chat window's model picker wins, because it
 * is the more specific and more recent expression of intent. That includes
 * choosing "off", which has to be able to override a global default that is on —
 * otherwise the picker could only ever raise reasoning, never suppress it for a
 * single conversation. Otherwise the global default from the status bar
 * (equivalently, the settings page) applies, and that default can also be off.
 */
export function resolveThinkingForTurn(
	variantEffort: VariantSelection | undefined,
	defaults: { enabled: boolean; effort: ThinkingEffort }
): { enabled: boolean; effort: ThinkingEffort; source: "model-picker" | "default" } {
	if (isOffSelection(variantEffort)) {
		// The effort is still reported so callers can log what was suppressed, but
		// `enabled: false` means nothing reasoning-related reaches the wire.
		return { enabled: false, effort: defaults.effort, source: "model-picker" };
	}
	if (variantEffort !== undefined) {
		return { enabled: true, effort: variantEffort, source: "model-picker" };
	}
	return { enabled: defaults.enabled, effort: defaults.effort, source: "default" };
}

/**
 * Short label for an effort level's token cost.
 *
 * Superseded in the quick pick by `describeAvailability`, which also says
 * whether the level fits the current output-token limit. Kept because it is the
 * only description that needs no model context.
 */
export function describeEffort(effort: ThinkingEffort): string {
	return `${budgetForEffort(effort).toLocaleString("en-US")}-token budget`;
}
