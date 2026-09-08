import * as vscode from "vscode";
import { logger } from "./logger";

function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
	for (const tool of tools) {
		if (!tool.name.match(/^[\w-]+$/)) {
			logger.error("[Validation] Invalid tool name detected:", tool.name);
			throw new Error(
				`Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
			);
		}
	}
}

export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		logger.error("[Validation] No messages in request");
		throw new Error("Invalid request: no messages.");
	}

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set(
				message.content
					.filter((part) => part instanceof vscode.LanguageModelToolCallPart)
					.map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
			);
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			const errMsg =
				"Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
					logger.error("[Validation] Missing tool result for call IDs:", Array.from(toolCallIds));
					throw new Error(errMsg);
				}

				nextMessage.content.forEach((part) => {
					if (!isToolResultPart(part)) {
						const ctorName =
							(Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor
								?.name ?? typeof part;
						logger.error("[Validation] Expected tool result part, got:", ctorName);
						throw new Error(errMsg);
					}
					const callId = (part as { callId: string }).callId;
					toolCallIds.delete(callId);
				});
			}
		}
	});
}

/** Setting IDs, so guidance text and the "open setting" actions cannot drift. */
export const MAX_OUTPUT_TOKENS_SETTING = "languageModelChatProvider.bedrock.maxOutputTokens";
export const THINKING_EFFORT_SETTING = "languageModelChatProvider.bedrock.thinking.effort";
export const THINKING_BUDGET_SETTING = "languageModelChatProvider.bedrock.thinking.budgetTokens";

/**
 * Explain an output-token cap that is too small for the requested reasoning
 * effort, and say how to fix it.
 *
 * Thrown before the API call rather than letting Bedrock reject the request:
 * its own message ("`max_tokens` must be greater than `thinking.budget_tokens`")
 * names wire fields that no setting in this extension is called, so it gives the
 * user nothing to act on.
 */
export function describeThinkingBudgetConflict(conflict: {
	maxTokens: number;
	requiredMaxTokens: number;
	effort: string;
	source: "request" | "setting";
	ceiling: number;
}): string {
	const n = (v: number) => v.toLocaleString("en-US");
	const required = n(conflict.requiredMaxTokens);

	if (conflict.source === "request") {
		return (
			`Extended thinking at effort "${conflict.effort}" needs at least ${required} output tokens, ` +
			`but this request asked for only ${n(conflict.maxTokens)}. ` +
			`Lower the thinking effort, or turn extended thinking off for this conversation.`
		);
	}

	const fitsAtCeiling = conflict.requiredMaxTokens <= conflict.ceiling;
	const remedy = fitsAtCeiling
		? `Set "${MAX_OUTPUT_TOKENS_SETTING}" to 0 to use the model's maximum of ${n(conflict.ceiling)}, ` +
			`or raise it to at least ${required}.`
		: `This model allows at most ${n(conflict.ceiling)} output tokens, which cannot fit this effort level — ` +
			`lower "${THINKING_EFFORT_SETTING}" instead.`;

	return (
		`Extended thinking at effort "${conflict.effort}" needs at least ${required} output tokens, ` +
		`but "${MAX_OUTPUT_TOKENS_SETTING}" is set to ${n(conflict.maxTokens)}. ${remedy}`
	);
}

/**
 * Rewrite a Bedrock validation error into something the user can act on, or
 * return `undefined` to leave it alone.
 *
 * A safety net for paths the pre-flight checks do not cover: a model whose real
 * budget differs from the effort table, a future field name, a cap injected by
 * something other than our own settings. Matching on message text is brittle by
 * nature, hence the fallthrough.
 */
export function explainBedrockValidationError(
	message: string,
	context: { maxTokens?: number; effort?: string; thinkingEnabled?: boolean }
): string | undefined {
	const lower = message.toLowerCase();
	const cap = context.maxTokens !== undefined ? context.maxTokens.toLocaleString("en-US") : "the configured limit";

	if (lower.includes("max_tokens") && lower.includes("budget_tokens")) {
		return (
			`The output-token limit is too small for extended thinking. ` +
			`This request allowed ${cap} output tokens` +
			(context.effort ? ` at thinking effort "${context.effort}"` : "") +
			`, and the model's reasoning budget alone exceeds that. ` +
			`Set "${MAX_OUTPUT_TOKENS_SETTING}" to 0 to use the model's maximum, ` +
			`lower "${THINKING_EFFORT_SETTING}", or turn extended thinking off. ` +
			`Original error: ${message}`
		);
	}

	if (lower.includes("budget_tokens") && (lower.includes("at least") || lower.includes("greater than or equal"))) {
		return (
			`The configured thinking budget is below the minimum this model accepts. ` +
			`Set "${THINKING_BUDGET_SETTING}" to 0 to derive it from the effort level. ` +
			`Original error: ${message}`
		);
	}

	if (lower.includes("max_tokens") && (lower.includes("exceed") || lower.includes("less than or equal"))) {
		return (
			`The requested output-token limit of ${cap} exceeds what this model accepts. ` +
			`Set "${MAX_OUTPUT_TOKENS_SETTING}" to 0 to use the model's own maximum. ` +
			`Original error: ${message}`
		);
	}

	if (context.thinkingEnabled && (lower.includes("temperature") || lower.includes("top_p") || lower.includes("topp"))) {
		return (
			`This model rejects sampling parameters while extended thinking is active. ` +
			`Turn extended thinking off if you need to set temperature or top_p. ` +
			`Original error: ${message}`
		);
	}

	return undefined;
}

/**
 * An output-token cap low enough that it will truncate ordinary work.
 *
 * Not enforced as a schema `minimum`, because `0` is a meaningful value ("use the
 * model maximum") and JSON Schema cannot express "0 or at least N". Validated
 * here instead, and reported once rather than on every request.
 */
export const IMPRACTICAL_MAX_OUTPUT_TOKENS = 1024;

export interface SettingsAdvisory {
	/** Stable key, so the same advisory is not repeated after being dismissed. */
	id: string;
	message: string;
	severity: "warning";
}

/**
 * Check the token-limit settings for values that are technically valid but will
 * not work in practice.
 *
 * Pure, so the thresholds and wording are testable without a window. Returns
 * every applicable advisory; the caller decides which have already been shown.
 */
export function checkTokenSettings(settings: {
	/** The `maxOutputTokens` setting, undefined when unset. */
	maxOutputTokens?: number;
	thinkingEnabled: boolean;
	thinkingEffort: string;
	/** The `thinking.budgetTokens` setting, undefined when unset. */
	thinkingBudgetTokens?: number;
	/** Output tokens the current effort level needs. */
	requiredForEffort?: number;
}): SettingsAdvisory[] {
	const advisories: SettingsAdvisory[] = [];
	const cap = settings.maxOutputTokens;
	if (cap === undefined) {
		return advisories;
	}
	const n = (v: number) => v.toLocaleString("en-US");

	if (cap < IMPRACTICAL_MAX_OUTPUT_TOKENS) {
		advisories.push({
			id: `maxOutputTokens.tiny.${cap}`,
			severity: "warning",
			message:
				`"${MAX_OUTPUT_TOKENS_SETTING}" is set to ${n(cap)}, which is too small for normal use — ` +
				`responses and tool calls will be cut off part-way through. ` +
				`Set it to 0 to use each model's own maximum.`,
		});
		return advisories;
	}

	if (
		settings.thinkingEnabled &&
		settings.requiredForEffort !== undefined &&
		cap < settings.requiredForEffort
	) {
		advisories.push({
			id: `maxOutputTokens.thinking.${cap}.${settings.thinkingEffort}`,
			severity: "warning",
			message:
				`"${MAX_OUTPUT_TOKENS_SETTING}" is set to ${n(cap)}, but extended thinking at ` +
				`"${settings.thinkingEffort}" effort needs about ${n(settings.requiredForEffort)} output tokens. ` +
				`Set it to 0 to use each model's maximum, or lower the thinking effort.`,
		});
	}

	if (settings.thinkingBudgetTokens !== undefined && settings.thinkingBudgetTokens >= cap) {
		advisories.push({
			id: `thinkingBudget.exceedsCap.${settings.thinkingBudgetTokens}.${cap}`,
			severity: "warning",
			message:
				`"${THINKING_BUDGET_SETTING}" (${n(settings.thinkingBudgetTokens)}) is not smaller than ` +
				`"${MAX_OUTPUT_TOKENS_SETTING}" (${n(cap)}). Reasoning tokens are spent out of the output limit, ` +
				`so the model would have no room left to answer. Set the budget to 0 to derive it from the effort level.`,
		});
	}

	return advisories;
}
