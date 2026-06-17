import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";
import { BedrockClient } from "../clients/bedrock.client";
import { StreamProcessor } from "../stream-processor";
import { convertMessages } from "../converters/messages";
import { convertTools } from "../converters/tools";
import { buildRequestInput } from "../converters/request";
import { getModelProfile } from "../profiles";
import { validateRequest } from "../validation";
import { logger } from "../logger";
import { ModelService } from "../services/model.service";
import { AuthenticationService } from "../services/authentication.service";
import { ConfigurationService } from "../services/configuration.service";
import { TokenEstimator } from "./token.estimator";

/**
 * Handles chat request processing for Bedrock models.
 * Coordinates message conversion, validation, and streaming.
 */
export class ChatRequestHandler {
	private bedrockClient: BedrockClient;
	private streamProcessor: StreamProcessor;
	private tokenEstimator: TokenEstimator;
	/**
	 * Reasoning captured from the most recent assistant turn, keyed by a stable
	 * conversation signature. Replayed into the next request so interleaved
	 * thinking + tool use round-trips correctly (Anthropic requires the signed
	 * reasoning block on follow-up tool turns).
	 */
	private lastReasoning: { text: string; signature?: string } | undefined;

	constructor(
		private readonly modelService: ModelService,
		private readonly authService: AuthenticationService,
		private readonly configService: ConfigurationService
	) {
		const region = this.configService.getRegion();
		this.bedrockClient = new BedrockClient(region);
		this.streamProcessor = new StreamProcessor();
		this.tokenEstimator = new TokenEstimator();
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

		try {
			const authConfig = await this.authService.getAuthConfig();
			if (!authConfig) {
				throw new Error("Bedrock authentication not configured");
			}

			logger.log("[Chat Request Handler] Converting messages, count:", messages.length);
			messages.forEach((msg, idx) => {
				const partTypes = msg.content.map(p => {
					if (p instanceof vscode.LanguageModelTextPart) return 'text';
					if (p instanceof vscode.LanguageModelToolCallPart) return 'toolCall';
					if (typeof p === 'object' && p !== null && 'mimeType' in p && (p as any).mimeType?.startsWith('image/')) return 'image';
					return 'toolResult';
				});
				logger.log(`[Chat Request Handler] Message ${idx} (${msg.role}):`, partTypes);
			});

			const converted = convertMessages(messages, model.id, this.lastReasoning);
			validateRequest(messages);

			logger.log("[Chat Request Handler] Converted to Bedrock messages:", converted.messages.length);
			converted.messages.forEach((msg, idx) => {
				const contentTypes = msg.content.map(c => {
					if ('reasoningContent' in c) return 'reasoning';
					if ('text' in c) return 'text';
					if ('image' in c) return 'image';
					if ('toolUse' in c) return 'toolUse';
					return 'toolResult';
				});
				logger.log(`[Chat Request Handler] Bedrock message ${idx} (${msg.role}):`, contentTypes);
			});

			const profile = getModelProfile(model.id);

			if (options.tools && options.tools.length > 128) {
				throw new Error("Cannot have more than 128 tools per request.");
			}

			// Resolve thinking settings. The model picker (proposed `configurationSchema`
			// API) delivers the user's selection via `options.modelConfiguration`; when
			// present it takes precedence over the workspace/global settings defaults.
			const modelConfig = (options as unknown as {
				modelConfiguration?: { effort?: unknown; thinkingEnabled?: unknown };
			}).modelConfiguration;

			const validEfforts = ['max', 'xhigh', 'high', 'medium', 'low'];
			const pickerEffort =
				typeof modelConfig?.effort === 'string' && validEfforts.includes(modelConfig.effort)
					? (modelConfig.effort as 'max' | 'xhigh' | 'high' | 'medium' | 'low')
					: undefined;
			const pickerEnabled =
				typeof modelConfig?.thinkingEnabled === 'boolean' ? modelConfig.thinkingEnabled : undefined;

			const thinkingEnabled = pickerEnabled ?? this.configService.getThinkingEnabled();
			const thinkingEffort = pickerEffort ?? this.configService.getEffort();
			const thinkingActive = thinkingEnabled && profile.supportsThinking && profile.reasoningApi !== 'none';

			// Build tool config AFTER resolving thinking: forced tool choice must be
			// downgraded to "auto" when thinking is active (Anthropic constraint).
			const toolConfig = convertTools(options, model.id, thinkingActive);

			const inputTokenCount = this.tokenEstimator.estimateMessagesTokens(messages);
			const toolTokenCount = this.tokenEstimator.estimateToolTokens(toolConfig);
			const tokenLimit = Math.max(1, model.maxInputTokens);
			if (inputTokenCount + toolTokenCount > tokenLimit) {
				logger.error("[Chat Request Handler] Message exceeds token limit", {
					total: inputTokenCount + toolTokenCount,
					tokenLimit,
				});
				throw new Error("Message exceeds token limit.");
			}

			const requestInput = buildRequestInput({
				model,
				converted,
				options,
				profile,
				toolConfig,
				thinking: {
					enabled: thinkingEnabled,
					effort: thinkingEffort,
					budgetTokens: this.configService.getThinkingBudgetTokens(),
				},
			});

			if (profile.supportsThinking && thinkingEnabled) {
				logger.log("[Chat Request Handler] Thinking enabled", {
					effort: thinkingEffort,
					source: pickerEffort ? 'model-picker' : 'settings',
					reasoning_config: (requestInput as any).additionalModelRequestFields?.reasoning_config,
				});
			}

			logger.log("[Chat Request Handler] Starting streaming request");
			const credentials = this.authService.getCredentials(authConfig);
			const stream = await this.bedrockClient.startConversationStream(credentials, requestInput);

			logger.log("[Chat Request Handler] Processing stream events");
			await this.streamProcessor.processStream(stream, trackingProgress, token);
			logger.log("[Chat Request Handler] Finished processing stream");

			// Persist the signed reasoning from this turn so it can be replayed if
			// the model just requested a tool (the next request will carry the tool
			// results and must include this thinking block). Cleared when a turn
			// produces no reasoning (e.g. thinking disabled or skipped).
			this.lastReasoning = this.streamProcessor.getCapturedReasoning();
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Chat Request Handler] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			vscode.window.showErrorMessage(`Bedrock chat request failed: ${errorMsg}`);
			throw err;
		}
	}
}
