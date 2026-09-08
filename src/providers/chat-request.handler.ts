import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";
import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClient } from "../clients/bedrock.client";
import { StreamProcessor } from "../stream-processor";
import { convertMessages } from "../converters/messages";
import { convertTools } from "../converters/tools";
import { buildRequestInput } from "../converters/request";
import { getModelProfile } from "../profiles";
import { decodeVariantId, resolveThinkingForTurn } from "../thinking-variants";
import {
	validateRequest,
	describeThinkingBudgetConflict,
	explainBedrockValidationError,
	MAX_OUTPUT_TOKENS_SETTING,
} from "../validation";
import {
	showConfigurationProblem,
	reportConfigurationError,
	actionsForTokenLimit,
} from "../config-actions";
import { logger } from "../logger";
import { ModelService, defaultMaxOutputTokens } from "../services/model.service";
import { AuthenticationService } from "../services/authentication.service";
import { ConfigurationService } from "../services/configuration.service";
import { TokenEstimator } from "./token.estimator";
import { UsageTracker } from "../usage-tracker";
import type { BedrockMessage, ReasoningBlock, ToolCallFailure } from "../types";

/**
 * How many turns of signed reasoning to keep for replay. Extended thinking with
 * tool use requires the previous turn's reasoning to be sent back verbatim, but
 * only the turns still present in the conversation matter, so the map is trimmed
 * rather than grown without bound for the life of the window.
 */
const MAX_REASONING_ENTRIES = 64;

/**
 * Marker for errors whose message has already been shown to the user.
 *
 * The catch block is the single place that surfaces failures, but the
 * configuration pre-flight needs to show its own actionable message before
 * throwing. Without a marker the user would get two toasts for one problem.
 */
const REPORTED = Symbol("bedrock.errorReported");

function markReported<T extends Error>(err: T): T {
	(err as unknown as Record<symbol, boolean>)[REPORTED] = true;
	return err;
}

function wasReported(err: unknown): boolean {
	return Boolean(err && typeof err === "object" && (err as Record<symbol, boolean>)[REPORTED]);
}

/**
 * Handles chat request processing for Bedrock models.
 * Coordinates message conversion, validation, and streaming.
 */
export class ChatRequestHandler {
	private bedrockClient: BedrockClient;
	private streamProcessor: StreamProcessor;
	private tokenEstimator: TokenEstimator;
	private usageTracker: UsageTracker;

	/**
	 * Reasoning captured from previous turns, keyed by a toolUseId that the turn
	 * produced.
	 *
	 * Keyed rather than held in a single "last reasoning" field on purpose. VS
	 * Code runs chat requests concurrently, so one field is overwritten by
	 * whichever request finishes last and the reasoning replayed on the next turn
	 * belongs to a different conversation, which Bedrock rejects because the
	 * signature does not match the content.
	 */
	private reasoningByToolUseId = new Map<string, ReasoningBlock[]>();

	constructor(
		private readonly modelService: ModelService,
		private readonly authService: AuthenticationService,
		private readonly configService: ConfigurationService
	) {
		const region = this.configService.getRegion();
		this.bedrockClient = new BedrockClient(region);
		this.streamProcessor = new StreamProcessor();
		this.tokenEstimator = new TokenEstimator();
		this.usageTracker = new UsageTracker();
	}

	/**
	 * Handle configuration changes
	 */
	handleConfigurationChange(): void {
		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);
	}

	/**
	 * Process a chat request and stream the response
	 */
	async handleChatRequest(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					logger.error("[Chat Request Handler] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};

		// Bridge cancellation to the SDK so stopping a request actually tears down
		// the HTTP connection instead of just ending our read loop.
		const abortController = new AbortController();
		const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());

		// Populated as the request is assembled so the catch block can explain a
		// failure in terms of what was actually sent.
		const diagnostics: {
			maxTokens?: number;
			effort?: string;
			thinkingEnabled?: boolean;
			/** Whether a user setting, rather than the model, set the limit. */
			maxTokensFromSetting?: boolean;
		} = {};

		try {
			const authConfig = await this.authService.getAuthConfig();
			if (!authConfig) {
				throw new Error("Bedrock authentication not configured");
			}

			// One summary line, not one line per message. A long agent session sends
			// over a hundred messages per turn, and the old per-message dump buried
			// everything worth reading in the output channel.
			logger.log("[Chat Request Handler] Converting messages", {
				count: messages.length,
				parts: tallyParts(messages),
			});

			// The picker ID may carry an effort level appended by the model-variant
			// expansion. Everything downstream — capability detection, the wire
			// modelId, invocation-target lookup — needs the real Bedrock ID.
			const variant = decodeVariantId(model.id);
			const modelId = variant.baseId;

			const profile = getModelProfile(modelId);
			const thinking = resolveThinkingForTurn(variant.effort, {
				enabled: this.configService.isThinkingEnabled(),
				effort: this.configService.getThinkingEffort(),
			});
			const thinkingRequested = thinking.enabled;
			const thinkingPossible = thinkingRequested && profile.thinkingApi !== "none";

			const converted = convertMessages(messages, modelId, {
				// Only replay reasoning when it will actually be needed. Sending it to
				// a request that has thinking off is a validation error.
				reasoningByToolUseId: thinkingPossible ? this.reasoningByToolUseId : undefined,
			});
			validateRequest(messages);

			logger.log("[Chat Request Handler] Converted to Bedrock messages", {
				count: converted.messages.length,
				systemBlocks: converted.system.length,
				blocks: tallyBlocks(converted.messages),
			});

			const toolConfig = convertTools(options, modelId);

			if (options.tools && options.tools.length > 128) {
				throw new Error("Cannot have more than 128 tools per request.");
			}

			const built = buildRequestInput({
				model: { id: modelId, maxOutputTokens: model.maxOutputTokens },
				converted,
				options,
				profile,
				toolConfig,
				maxOutputTokensOverride: this.configService.getMaxOutputTokens(),
				// If VS Code hands back a model with no usable ceiling, fall back to the
				// family default rather than letting a pathological value through.
				fallbackMaxOutputTokens: defaultMaxOutputTokens(modelId),
				thinking: {
					enabled: thinkingRequested,
					effort: thinking.effort,
					budgetTokens: this.configService.getThinkingBudgetTokens(),
				},
				promptCaching: this.configService.isPromptCachingEnabled(),
			});
			const requestInput = built.input;
			const resolution = built.maxTokens;

			diagnostics.maxTokens = resolution.maxTokens;
			diagnostics.thinkingEnabled = built.thinkingEnabled;
			diagnostics.effort = built.thinkingEnabled ? thinking.effort : undefined;
			diagnostics.maxTokensFromSetting = resolution.source === "setting";

			// Fail before the API call when an explicit cap cannot house the requested
			// reasoning budget. Bedrock would reject this too, but its message names
			// wire fields rather than the settings the user would have to change.
			if (resolution.conflict) {
				const detail = describeThinkingBudgetConflict(resolution.conflict);
				logger.error("[Chat Request Handler] Output-token limit too small for thinking", resolution.conflict);
				void showConfigurationProblem(
					detail,
					actionsForTokenLimit(resolution.conflict.source === "setting")
				);
				throw markReported(new Error(detail));
			}

			// One line showing the whole precedence chain, not just the outcome. The
			// `maxTokens: 1` regression was invisible for exactly this reason: the log
			// showed the final value with no indication of which input produced it.
			logger.log("[Chat Request Handler] Resolved output-token limit", {
				maxTokens: resolution.maxTokens,
				source: resolution.source,
				modelCeiling: resolution.ceiling,
				thinkingFloor: resolution.thinkingFloor,
				thinkingBudget: resolution.budgetTokens,
				...(resolution.effort && { effort: resolution.effort }),
				...(resolution.clampedToCeiling && { clampedToCeiling: true }),
			});

			// The adaptive API derives its budget from the effort level server-side,
			// so a caller-supplied max_tokens smaller than that budget can only be
			// accommodated by asking for less effort. Say so, because the user set a
			// level and is getting a different one.
			if (resolution.effortDowngradedFrom) {
				logger.warn(
					`[Chat Request Handler] Reasoning effort reduced from "${resolution.effortDowngradedFrom}" to ` +
						`"${resolution.effort}" for this request: it allows ${resolution.maxTokens} output tokens, ` +
						`which cannot accommodate the higher level's reasoning budget.`
				);
			}

			if (thinkingRequested && !built.thinkingEnabled && profile.thinkingApi !== "none") {
				logger.warn(
					"[Chat Request Handler] Extended thinking dropped for this turn: the output-token limit " +
						`of ${resolution.maxTokens} cannot accommodate a reasoning budget.`
				);
			}

			if (resolution.source === "setting" && resolution.maxTokens < resolution.ceiling) {
				logger.warn(
					`[Chat Request Handler] "${MAX_OUTPUT_TOKENS_SETTING}" limits responses to ` +
						`${resolution.maxTokens} of the model's ${resolution.ceiling} output tokens. ` +
						"Set it to 0 to use the model maximum; a low cap truncates large tool calls."
				);
			}

			// Substitute invocation target (override ARN or system profile) at the wire level.
			// This keeps the bare model ID for getModelProfile() so capability detection
			// (e.g. temperature suppression for Claude 4+) still works correctly.
			const invocationTarget = this.modelService.getInvocationTarget(modelId);
			if (invocationTarget) {
				requestInput.modelId = invocationTarget;
			}

			const credentials = this.authService.getCredentials(authConfig);

			const tokenLimit = Math.max(1, model.maxInputTokens);
			const { inputTokens, source } = await this.countInputTokens({
				credentials,
				modelId: requestInput.modelId ?? modelId,
				requestInput,
				messages,
				converted,
				toolConfig,
				abortSignal: abortController.signal,
			});

			if (inputTokens > tokenLimit) {
				logger.error("[Chat Request Handler] Message exceeds token limit", {
					total: inputTokens,
					tokenLimit,
					source,
				});
				throw new Error(
					`Message exceeds token limit (${inputTokens} > ${tokenLimit}). Start a new chat or remove some context.`
				);
			}

			logger.log("[Chat Request Handler] Starting streaming request", {
				modelId: requestInput.modelId,
				maxTokens: requestInput.inferenceConfig?.maxTokens,
				thinking: built.thinkingEnabled,
				thinkingEffort: built.thinkingEnabled ? thinking.effort : undefined,
				thinkingSource: built.thinkingEnabled ? thinking.source : undefined,
				cachePoints: built.cachePoints,
				inputTokens,
				tokenSource: source,
			});

			const stream = await this.bedrockClient.startConversationStream(
				credentials,
				requestInput,
				abortController.signal
			);

			logger.log("[Chat Request Handler] Processing stream events");
			const result = await this.streamProcessor.processStream(stream, trackingProgress, token, {
				thinkingDisplay: built.thinkingEnabled ? this.configService.getThinkingDisplay() : "hidden",
			});
			logger.log("[Chat Request Handler] Finished processing stream");

			this.usageTracker.record({
				modelId,
				stopReason: result.stopReason,
				usage: result.usage,
				latencyMs: result.latencyMs,
				estimatedInputTokens: inputTokens,
				estimateSource: source,
				maxInputTokens: tokenLimit,
				maxOutputTokens: requestInput.inferenceConfig?.maxTokens ?? 0,
				emittedToolCalls: result.emittedToolCalls,
				cachePoints: built.cachePoints,
				thinkingEnabled: built.thinkingEnabled,
			});

			this.rememberReasoning(result.reasoning, result.toolUseIds);

			if (result.toolCallFailures.length > 0 && !token.isCancellationRequested) {
				throw new Error(
					describeToolCallFailure(
						result.toolCallFailures,
						result.stopReason,
						requestInput.inferenceConfig?.maxTokens ?? 0,
						model.maxOutputTokens,
						resolution.source
					)
				);
			}
		} catch (err) {
			// Cancellation is not a failure and should not raise an error toast.
			if (abortController.signal.aborted || token.isCancellationRequested) {
				logger.log("[Chat Request Handler] Request cancelled");
				return;
			}

			const rawMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Chat Request Handler] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				...diagnostics,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});

			// Already explained and shown to the user by a pre-flight check, so do not
			// raise a second toast for the same problem.
			if (wasReported(err)) {
				throw err;
			}

			// Bedrock's own validation messages name wire fields (`max_tokens`,
			// `thinking.budget_tokens`) that match no setting the user can find.
			// Translate the ones we recognize into the remedy.
			const explained = explainBedrockValidationError(rawMsg, {
				maxTokens: diagnostics.maxTokens,
				effort: diagnostics.effort,
				thinkingEnabled: diagnostics.thinkingEnabled,
			});
			if (explained) {
				void showConfigurationProblem(explained, actionsForTokenLimit(diagnostics.maxTokensFromSetting ?? true));
				throw markReported(new Error(explained));
			}

			// Auth, region and model-access failures are configuration problems too, and
			// were previously reported as bare text with nothing to click.
			if (await reportConfigurationError(rawMsg)) {
				throw markReported(err instanceof Error ? err : new Error(rawMsg));
			}

			vscode.window.showErrorMessage(`Bedrock chat request failed: ${rawMsg}`);
			// Rethrow the original so its type and stack survive for anything
			// upstream that inspects them.
			throw err;
		} finally {
			cancellationSubscription.dispose();
		}
	}

	/**
	 * Show a configuration failure with the two actions that can actually resolve
	 * it, rather than a message the user has to translate into a settings search.
	 */
	private async offerMaxTokensFix(message: string): Promise<void> {
		const openSetting = "Open Setting";
		const changeEffort = "Change Thinking Effort";
		const choice = await vscode.window.showErrorMessage(message, openSetting, changeEffort);
		if (choice === openSetting) {
			await vscode.commands.executeCommand("workbench.action.openSettings", MAX_OUTPUT_TOKENS_SETTING);
		} else if (choice === changeEffort) {
			await vscode.commands.executeCommand("bedrock.selectThinkingEffort");
		}
	}

	/**
	 * Determine the input token count for a request, preferring Bedrock's own
	 * tokenizer over the character heuristic.
	 */
	private async countInputTokens(params: {
		credentials: Parameters<BedrockClient["countTokens"]>[0];
		modelId: string;
		requestInput: ConverseStreamCommandInput;
		messages: readonly LanguageModelChatMessage[];
		converted: { messages: unknown[]; system: unknown[] };
		toolConfig: unknown;
		abortSignal: AbortSignal;
	}): Promise<{ inputTokens: number; source: "native" | "heuristic" }> {
		const heuristic =
			this.tokenEstimator.estimateMessagesTokens(params.messages) +
			this.tokenEstimator.estimateToolTokens(params.toolConfig as never) +
			this.tokenEstimator.estimateSystemTokens(
				(params.converted.system as Array<{ text?: string }>) ?? []
			);

		if (!this.configService.isNativeTokenCountingEnabled()) {
			return { inputTokens: heuristic, source: "heuristic" };
		}

		const native = await this.bedrockClient.countTokens(
			params.credentials,
			params.modelId,
			{
				messages: params.requestInput.messages,
				system: params.requestInput.system,
				toolConfig: params.requestInput.toolConfig,
			},
			params.abortSignal
		);

		return native !== undefined
			? { inputTokens: native, source: "native" }
			: { inputTokens: heuristic, source: "heuristic" };
	}

	/**
	 * Store this turn's reasoning against every tool call it produced, so the
	 * follow-up request carrying those tool results can replay it.
	 */
	private rememberReasoning(reasoning: ReasoningBlock[], toolUseIds: string[]): void {
		if (reasoning.length === 0 || toolUseIds.length === 0) {
			return;
		}
		for (const id of toolUseIds) {
			this.reasoningByToolUseId.set(id, reasoning);
		}
		while (this.reasoningByToolUseId.size > MAX_REASONING_ENTRIES) {
			const oldest = this.reasoningByToolUseId.keys().next();
			if (oldest.done) {
				break;
			}
			this.reasoningByToolUseId.delete(oldest.value);
		}
	}
}

/** Count the incoming VS Code content parts by kind, for one compact log line. */
function tallyParts(messages: readonly LanguageModelChatMessage[]): Record<string, number> {
	const tally: Record<string, number> = {};
	const bump = (kind: string) => {
		tally[kind] = (tally[kind] ?? 0) + 1;
	};

	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				bump("text");
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				bump("toolCall");
			} else if (isImagePart(part)) {
				bump("image");
			} else {
				bump("toolResult");
			}
		}
	}
	return tally;
}

function isImagePart(part: unknown): boolean {
	if (!part || typeof part !== "object" || !("mimeType" in part)) {
		return false;
	}
	const mimeType = (part as { mimeType?: unknown }).mimeType;
	return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/** Count the outgoing Bedrock content blocks by kind. */
function tallyBlocks(messages: readonly BedrockMessage[]): Record<string, number> {
	const tally: Record<string, number> = {};
	const bump = (kind: string) => {
		tally[kind] = (tally[kind] ?? 0) + 1;
	};

	for (const message of messages) {
		for (const block of message.content) {
			if ("text" in block) {
				bump("text");
			} else if ("image" in block) {
				bump("image");
			} else if ("toolUse" in block) {
				bump("toolUse");
			} else if ("reasoningContent" in block) {
				bump("reasoning");
			} else if ("cachePoint" in block) {
				bump("cachePoint");
			} else {
				bump("toolResult");
			}
		}
	}
	return tally;
}

/**
 * Turn a dropped tool call into something the user can act on.
 *
 * The original behaviour logged "Invalid JSON for tool call" and returned
 * normally, so the agent simply stopped with no visible reason. Truncation from
 * an output-token cap is by far the most common cause, so name that explicitly
 * when the stop reason confirms it. The call is deliberately not repaired or
 * invented: half a tool call for a file edit would apply a truncated
 * replacement string and corrupt the file.
 */
export function describeToolCallFailure(
	failures: readonly ToolCallFailure[],
	stopReason: string | undefined,
	maxTokens: number,
	modelMaxOutputTokens: number,
	/** Which input decided the cap, so the remedy names the right one. */
	maxTokensSource?: "request" | "setting" | "model-ceiling"
): string {
	const names = failures.map((f) => f.name ?? `#${f.index}`).join(", ");

	if (stopReason === "max_tokens") {
		const ceiling = modelMaxOutputTokens > 0 ? ` The model allows up to ${modelMaxOutputTokens}.` : "";
		// Telling the user to raise the setting is wrong when it is already at its
		// "use the model maximum" default, or when the cap came from the request.
		const remedy =
			maxTokensSource === "setting"
				? `Set "${MAX_OUTPUT_TOKENS_SETTING}" to 0 to use the model's maximum, or ask for a smaller change, then retry.`
				: maxTokensSource === "model-ceiling"
					? `That is already this model's maximum, so ask for a smaller change — for example one file at a time — then retry.`
					: `Ask for a smaller change, then retry. If you set "${MAX_OUTPUT_TOKENS_SETTING}", set it to 0 to use the model's maximum.`;
		return (
			`The model ran out of output tokens partway through a tool call (${names}), so its arguments were cut off ` +
			`and could not be used. The response was limited to ${maxTokens} output tokens.${ceiling} ${remedy}`
		);
	}

	return (
		`The model produced a tool call (${names}) whose arguments were not valid JSON, so it could not be run. ` +
		`Retry the request. See the "Bedrock Chat" output channel for the partial arguments.`
	);
}
