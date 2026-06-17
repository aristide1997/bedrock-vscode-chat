import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { BedrockModelSummary, AuthConfig } from "../types";
import { BedrockClient } from "../clients/bedrock.client";
import { OpenRouterClient } from "./openrouter.client";
import { AuthenticationService } from "./authentication.service";
import { ConfigurationService } from "./configuration.service";
import { getModelProfile } from "../profiles";
import { logger } from "../logger";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_CONTEXT_LENGTH = 200000;

/**
 * Manages model information, capabilities, and metadata.
 * Coordinates between AWS Bedrock and OpenRouter data sources.
 */
export class ModelService {
	private bedrockClient: BedrockClient;
	private openRouterClient: OpenRouterClient;
	private chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];

	constructor(
		private readonly authService: AuthenticationService,
		private readonly configService: ConfigurationService
	) {
		const region = this.configService.getRegion();
		this.bedrockClient = new BedrockClient(region);
		this.openRouterClient = new OpenRouterClient();
	}

	/**
	 * Handle configuration changes (e.g., region updates)
	 */
	handleConfigurationChange(): void {
		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);
		logger.log("[Model Service] Configuration changed, region updated to:", region);
	}

	/**
	 * Fetch and prepare language model chat information
	 */
	async getLanguageModelChatInformation(
		silent: boolean = false
	): Promise<LanguageModelChatInformation[]> {
		const authConfig = await this.authService.getAuthConfig(silent);
		if (!authConfig) {
			return [];
		}

		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);

		let models: BedrockModelSummary[];
		let availableProfileIds: Set<string>;

		try {
			const credentials = this.authService.getCredentials(authConfig);
			[models, availableProfileIds] = await Promise.all([
				this.bedrockClient.fetchModels(credentials),
				this.bedrockClient.fetchInferenceProfiles(credentials),
			]);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Model Service] Failed to fetch models", err);
			if (!silent) {
				vscode.window.showErrorMessage(`Failed to fetch Bedrock models: ${errorMsg}`);
			}
			return [];
		}

		const infos: LanguageModelChatInformation[] = [];
		const regionPrefix = region.split("-")[0];

		for (const m of models) {
			if (!m.responseStreamingSupported || !m.outputModalities.includes("TEXT")) {
				continue;
			}

			const inferenceProfileId = `${regionPrefix}.${m.modelId}`;
			const hasInferenceProfile = availableProfileIds.has(inferenceProfileId);
			const modelIdToUse = hasInferenceProfile ? inferenceProfileId : m.modelId;

			// Try to get model properties from OpenRouter, fall back to defaults
			const properties = await this.openRouterClient.getModelProperties(modelIdToUse);
			const maxInput = properties?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = properties?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
			const vision = m.inputModalities.includes("IMAGE");
			const profile = getModelProfile(modelIdToUse);

			const modelInfo: LanguageModelChatInformation = {
				id: modelIdToUse,
				name: m.modelName,
				tooltip: `AWS Bedrock - ${m.providerName}${hasInferenceProfile ? ' (Cross-Region)' : ''}`,
				detail: `${m.providerName} • ${hasInferenceProfile ? 'Multi-Region' : region}`,
				family: "bedrock",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: {
					toolCalling: true,
					imageInput: vision,
				},
			};

			// Expose a thinking-effort control in the model picker for models that
			// support reasoning. This uses the proposed `configurationSchema` API:
			// a property with `group: "navigation"` renders as a primary action in
			// the picker, and the chosen value is delivered back to the provider via
			// `options.modelConfiguration` on each request.
			if (profile.supportsThinking && profile.reasoningApi !== 'none') {
				const isAdaptive = profile.reasoningApi === 'effort';
				const effortEnum = isAdaptive
					? ['max', 'xhigh', 'high', 'medium', 'low']
					: ['max', 'high', 'medium', 'low'];
				const effortLabels = isAdaptive
					? ['Max', 'Extra High', 'High', 'Medium', 'Low']
					: ['Max', 'High', 'Medium', 'Low'];

				(modelInfo as unknown as { configurationSchema?: unknown }).configurationSchema = {
					properties: {
						effort: {
							type: 'string',
							enum: effortEnum,
							enumItemLabels: effortLabels,
							default: this.configService.getEffort(),
							description: 'Reasoning effort. Higher effort lets the model think longer before answering.',
							group: 'navigation',
						},
						thinkingEnabled: {
							type: 'boolean',
							default: this.configService.getThinkingEnabled(),
							description: 'Enable extended thinking / reasoning for this model.',
						},
					},
				};
			}

			infos.push(modelInfo);
		}

		this.chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		return infos;
	}

	/**
	 * Get cached chat endpoints
	 */
	getChatEndpoints(): { model: string; modelMaxPromptTokens: number }[] {
		return this.chatEndpoints;
	}
}
