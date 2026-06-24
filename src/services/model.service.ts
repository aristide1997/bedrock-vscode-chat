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
	/**
	 * Maps a bare model ID to the actual target to use at invocation time.
	 * This is either a user-provided override ARN or a system inference profile ID.
	 * The public model ID stays bare so capability detection (getModelProfile) still works.
	 */
	private invocationTargets = new Map<string, string>();

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
		const regionGeo = region.startsWith("ap-") ? "apac" : region.split("-")[0];
		const overrides = this.configService.getInferenceProfileOverrides();
		this.invocationTargets.clear();

		for (const m of models) {
			if (!m.responseStreamingSupported || !m.outputModalities.includes("TEXT")) {
				continue;
			}

			// Resolution order: user override → system inference profile → bare ID
			const overrideTarget = overrides[m.modelId];
			if (overrideTarget) {
				this.invocationTargets.set(m.modelId, overrideTarget);
			} else {
				const candidates = [...availableProfileIds].filter((pid) => pid.endsWith(`.${m.modelId}`));
				const matchingProfileId =
					candidates.find((pid) => pid.startsWith(`${regionGeo}.`)) ??
					candidates.find((pid) => pid.startsWith("au.")) ??
					candidates.find((pid) => pid.startsWith("global.")) ??
					candidates[0];
				if (matchingProfileId) {
					this.invocationTargets.set(m.modelId, matchingProfileId);
				}
			}

			const hasInferenceProfile = this.invocationTargets.has(m.modelId);

			// Try to get model properties from OpenRouter, fall back to defaults
			const properties = await this.openRouterClient.getModelProperties(m.modelId);
			const maxInput = properties?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = properties?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
			const vision = m.inputModalities.includes("IMAGE");

			const modelInfo: LanguageModelChatInformation = {
				id: m.modelId,
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
	 * Get cached chat endpoints
	 */
	getChatEndpoints(): { model: string; modelMaxPromptTokens: number }[] {
		return this.chatEndpoints;
	}

	/**
	 * Get the invocation target (override ARN or system profile ID) for a bare model ID.
	 * Returns undefined if the model should be invoked with its bare ID directly.
	 */
	getInvocationTarget(bareModelId: string): string | undefined {
		return this.invocationTargets.get(bareModelId);
	}
}
