import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { BedrockModelSummary, AuthConfig } from "../types";
import { BedrockClient } from "../clients/bedrock.client";
import { OpenRouterClient } from "./openrouter.client";
import { AuthenticationService } from "./authentication.service";
import { ConfigurationService } from "./configuration.service";
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
			infos.push(modelInfo);
		}

		this.chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		return infos;
	}

	/**
	 * Check if a model supports thinking/reasoning
	 */
	async supportsThinking(modelId: string): Promise<boolean> {
		const thinkingConfig = this.configService.getThinkingConfig();
		if (!thinkingConfig) {
			return false;
		}

		return await this.openRouterClient.supportsThinking(modelId);
	}

	/**
	 * Get cached chat endpoints
	 */
	getChatEndpoints(): { model: string; modelMaxPromptTokens: number }[] {
		return this.chatEndpoints;
	}
}
