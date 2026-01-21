import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import type { BedrockModelSummary, AuthConfig } from "./types";
import { logger } from "./logger";

export class BedrockAPIClient {
	private region: string;
	private thinkingCapabilityCache: Map<string, boolean> = new Map();
	private openRouterMetadataCache: Map<string, any> = new Map();
	private openRouterCacheExpiry: number = 0;
	private static readonly OPENROUTER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

	constructor(region: string) {
		this.region = region;
	}

	setRegion(region: string): void {
		this.region = region;
	}

	/**
	 * Fetch model metadata from OpenRouter to determine thinking capability.
	 * OpenRouter exposes model capabilities that AWS Bedrock doesn't provide.
	 */
	private async fetchOpenRouterMetadata(): Promise<void> {
		const now = Date.now();

		// Return cached data if still valid
		if (this.openRouterMetadataCache.size > 0 && now < this.openRouterCacheExpiry) {
			return;
		}

		try {
			const response = await fetch("https://openrouter.ai/api/v1/models");
			if (!response.ok) {
				throw new Error(`OpenRouter API returned ${response.status}`);
			}

			const data = await response.json() as { data?: any[] };

			// Cache metadata for each model
			this.openRouterMetadataCache.clear();
			for (const model of data.data || []) {
				// Extract the base model ID (remove provider prefix if present)
				const modelId = model.id.includes('/') ? model.id.split('/')[1] : model.id;
				this.openRouterMetadataCache.set(modelId, model);
			}

			this.openRouterCacheExpiry = now + BedrockAPIClient.OPENROUTER_CACHE_TTL;
			logger.log("[Bedrock API Client] Fetched OpenRouter metadata for", this.openRouterMetadataCache.size, "models");
		} catch (error) {
			logger.error("[Bedrock API Client] Failed to fetch OpenRouter metadata", error);
		}
	}

	/**
	 * Check if a model supports thinking based on OpenRouter metadata.
	 * Falls back to false (no thinking) if metadata is unavailable.
	 */
	async supportsThinking(authConfig: AuthConfig, modelId: string): Promise<boolean> {
		// Check cache first
		if (this.thinkingCapabilityCache.has(modelId)) {
			return this.thinkingCapabilityCache.get(modelId)!;
		}

		// Try to get capability from OpenRouter metadata
		await this.fetchOpenRouterMetadata();

		// Normalize model ID for matching
		// - Remove region prefixes (us., eu., ap., global.)
		// - Convert dots to dashes for version consistency (4.5 -> 4-5, 3.7 -> 3-7)
		const normalizedModelId = modelId.replace(/^(us|eu|ap|global)\./i, '').toLowerCase().replace(/\./g, '-');

		// Check OpenRouter metadata for thinking capability
		for (const [cachedId, metadata] of this.openRouterMetadataCache.entries()) {
			// Apply same normalization to OpenRouter IDs
			const normalizedCachedId = cachedId.toLowerCase().replace(/\./g, '-');

			// Match if either ID contains the other (handles versioning differences)
			if (normalizedCachedId.includes(normalizedModelId) || normalizedModelId.includes(normalizedCachedId)) {
				const supportsReasoning = metadata.supported_parameters?.includes('reasoning') ||
				                         metadata.supported_parameters?.includes('include_reasoning');

				const result = supportsReasoning === true;
				this.thinkingCapabilityCache.set(modelId, result);
				logger.log(`[Bedrock API Client] Model ${modelId} thinking support: ${result} (from OpenRouter)`);
				return result;
			}
		}

		// Fallback: assume no thinking support if not found in OpenRouter metadata
		this.thinkingCapabilityCache.set(modelId, false);
		logger.log(`[Bedrock API Client] Model ${modelId} not found in OpenRouter metadata, assuming no thinking support`);
		return false;
	}

	/**
	 * Get cached thinking capability if available, without making API calls.
	 */
	getCachedThinkingCapability(modelId: string): boolean | undefined {
		return this.thinkingCapabilityCache.get(modelId);
	}

	/**
	 * Clear the thinking capability cache for a specific model or all models.
	 */
	clearThinkingCache(modelId?: string): void {
		if (modelId) {
			this.thinkingCapabilityCache.delete(modelId);
		} else {
			this.thinkingCapabilityCache.clear();
		}
	}

	/**
	 * Get model properties (context length, max output tokens) from OpenRouter metadata.
	 * Returns undefined if model not found or metadata not loaded.
	 */
	async getModelProperties(modelId: string): Promise<{ contextLength?: number; maxOutputTokens?: number } | undefined> {
		// Ensure OpenRouter metadata is loaded
		await this.fetchOpenRouterMetadata();

		// Normalize model ID for matching (remove region prefixes)
		const normalizedModelId = modelId.replace(/^(us|eu|ap|apac|global)\./i, '').toLowerCase().replace(/\./g, '-');

		// Search for matching model in OpenRouter metadata
		for (const [cachedId, metadata] of this.openRouterMetadataCache.entries()) {
			const normalizedCachedId = cachedId.toLowerCase().replace(/\./g, '-');

			// Match if either ID contains the other (handles versioning differences)
			if (normalizedCachedId.includes(normalizedModelId) || normalizedModelId.includes(normalizedCachedId)) {
				const contextLength = metadata.context_length as number | undefined;
				const maxOutputTokens = metadata.top_provider?.max_completion_tokens as number | undefined;

				logger.log(`[Bedrock API Client] Found OpenRouter metadata for ${modelId}:`, {
					contextLength,
					maxOutputTokens,
					matchedId: cachedId
				});

				return {
					contextLength,
					maxOutputTokens
				};
			}
		}

		logger.log(`[Bedrock API Client] No OpenRouter metadata found for ${modelId}`);
		return undefined;
	}

	async fetchModels(authConfig: AuthConfig): Promise<BedrockModelSummary[]> {
		try {
			const credentials = this.getCredentials(authConfig);

			const client = new BedrockClient({
				region: this.region,
				credentials,
			});

			const command = new ListFoundationModelsCommand({});
			const response = await client.send(command);

			return (response.modelSummaries ?? []).map((summary) => ({
				modelArn: summary.modelArn || "",
				modelId: summary.modelId || "",
				modelName: summary.modelName || "",
				providerName: summary.providerName || "",
				inputModalities: summary.inputModalities || [],
				outputModalities: summary.outputModalities || [],
				responseStreamingSupported: summary.responseStreamingSupported || false,
				customizationsSupported: summary.customizationsSupported,
				inferenceTypesSupported: summary.inferenceTypesSupported,
				modelLifecycle: summary.modelLifecycle,
			}));
		} catch (err) {
			logger.error("[Bedrock API Client] Failed to fetch Bedrock models", err);
			throw err;
		}
	}

	async fetchInferenceProfiles(authConfig: AuthConfig): Promise<Set<string>> {
		try {
			const credentials = this.getCredentials(authConfig);

			const client = new BedrockClient({
				region: this.region,
				credentials,
			});

			const command = new ListInferenceProfilesCommand({});
			const response = await client.send(command);

			const profileIds = new Set<string>();
			for (const profile of response.inferenceProfileSummaries ?? []) {
				if (profile.inferenceProfileId) {
					profileIds.add(profile.inferenceProfileId);
				}
			}

			return profileIds;
		} catch (err) {
			logger.error("[Bedrock API Client] Failed to fetch inference profiles", err);
			return new Set();
		}
	}

	async startConversationStream(
		authConfig: AuthConfig,
		input: ConverseStreamCommandInput
	): Promise<AsyncIterable<any>> {
		const credentials = this.getCredentials(authConfig);

		const client = new BedrockRuntimeClient({
			region: this.region,
			credentials,
		});

		const command = new ConverseStreamCommand(input);
		const response = await client.send(command);

		if (!response.stream) {
			throw new Error("No stream in response");
		}

		return response.stream;
	}

	private getCredentials(authConfig: AuthConfig) {
		// Clean up API key environment variable if not using API key auth
		if (authConfig.method !== 'api-key') {
			delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		}

		if (authConfig.method === 'api-key') {
			if (!authConfig.apiKey) {
				throw new Error('API key is required for api-key authentication method');
			}
			process.env.AWS_BEARER_TOKEN_BEDROCK = authConfig.apiKey;
			return undefined;
		}

		if (authConfig.method === 'profile') {
			if (!authConfig.profile) {
				throw new Error('Profile name is required for profile authentication method');
			}
			return fromIni({ profile: authConfig.profile });
		}

		if (authConfig.method === 'access-keys') {
			if (!authConfig.accessKeyId || !authConfig.secretAccessKey) {
				throw new Error('Access key ID and secret access key are required for access-keys authentication method');
			}
			return {
				accessKeyId: authConfig.accessKeyId,
				secretAccessKey: authConfig.secretAccessKey,
				...(authConfig.sessionToken && { sessionToken: authConfig.sessionToken }),
			};
		}

		// 'default' method - use AWS SDK's default credential provider chain
		// This will check environment variables, EC2 instance metadata, etc.
		return undefined;
	}
}
