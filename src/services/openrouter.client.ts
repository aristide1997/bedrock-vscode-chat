import { logger } from "../logger";
import { CacheService } from "./cache.service";

interface OpenRouterModel {
	id: string;
	context_length?: number;
	top_provider?: {
		max_completion_tokens?: number;
	};
	supported_parameters?: string[];
}

interface OpenRouterResponse {
	data?: OpenRouterModel[];
}

/**
 * Client for fetching model metadata from OpenRouter API.
 * Provides information about model capabilities that AWS Bedrock doesn't expose.
 */
export class OpenRouterClient {
	private static readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
	private static readonly API_URL = "https://openrouter.ai/api/v1/models";

	private metadataCache: CacheService<OpenRouterModel>;

	constructor() {
		this.metadataCache = new CacheService<OpenRouterModel>(
			"OpenRouter",
			OpenRouterClient.CACHE_TTL
		);
	}

	/**
	 * Fetch and cache model metadata from OpenRouter
	 */
	async fetchMetadata(): Promise<void> {
		// Return if cache is still valid
		if (this.metadataCache.isValid()) {
			return;
		}

		try {
			const response = await fetch(OpenRouterClient.API_URL);
			if (!response.ok) {
				throw new Error(`OpenRouter API returned ${response.status}`);
			}

			const data = (await response.json()) as OpenRouterResponse;

			// Cache metadata for each model
			const entries = new Map<string, OpenRouterModel>();
			for (const model of data.data || []) {
				// Extract the base model ID (remove provider prefix if present)
				const modelId = model.id.includes('/') ? model.id.split('/')[1] : model.id;
				entries.set(modelId, model);
			}

			this.metadataCache.setAll(entries);
			logger.log("[OpenRouter Client] Fetched metadata for", entries.size, "models");
		} catch (error) {
			logger.error("[OpenRouter Client] Failed to fetch metadata", error);
		}
	}

	/**
	 * Normalize a model ID for matching against OpenRouter data.
	 * Removes region prefixes and converts dots to dashes for consistency.
	 */
	private normalizeModelId(modelId: string): string {
		return modelId
			.replace(/^(us|eu|ap|apac|global)\./i, '')
			.toLowerCase()
			.replace(/\./g, '-');
	}

	/**
	 * Find OpenRouter metadata for a given Bedrock model ID
	 */
	private findMetadata(bedrockModelId: string): OpenRouterModel | undefined {
		const normalizedModelId = this.normalizeModelId(bedrockModelId);
		const allMetadata = this.metadataCache.getAll();

		for (const [cachedId, metadata] of allMetadata) {
			const normalizedCachedId = cachedId.toLowerCase().replace(/\./g, '-');

			// Match if either ID contains the other (handles versioning differences)
			if (normalizedCachedId.includes(normalizedModelId) || normalizedModelId.includes(normalizedCachedId)) {
				return metadata;
			}
		}

		return undefined;
	}

	/**
	 * Check if a model supports thinking/reasoning based on OpenRouter metadata
	 */
	async supportsThinking(modelId: string): Promise<boolean> {
		await this.fetchMetadata();

		const metadata = this.findMetadata(modelId);
		if (!metadata) {
			logger.log(`[OpenRouter Client] Model ${modelId} not found in OpenRouter metadata, assuming no thinking support`);
			return false;
		}

		const supportsReasoning = metadata.supported_parameters?.includes('reasoning') ||
		                         metadata.supported_parameters?.includes('include_reasoning');

		const result = supportsReasoning === true;
		logger.log(`[OpenRouter Client] Model ${modelId} thinking support: ${result}`);
		return result;
	}

	/**
	 * Get model properties (context length, max output tokens) from OpenRouter metadata
	 */
	async getModelProperties(modelId: string): Promise<{ contextLength?: number; maxOutputTokens?: number } | undefined> {
		await this.fetchMetadata();

		const metadata = this.findMetadata(modelId);
		if (!metadata) {
			logger.log(`[OpenRouter Client] No OpenRouter metadata found for ${modelId}`);
			return undefined;
		}

		const contextLength = metadata.context_length;
		const maxOutputTokens = metadata.top_provider?.max_completion_tokens;

		logger.log(`[OpenRouter Client] Found metadata for ${modelId}:`, {
			contextLength,
			maxOutputTokens
		});

		return {
			contextLength,
			maxOutputTokens
		};
	}

	/**
	 * Clear the metadata cache
	 */
	clearCache(): void {
		this.metadataCache.clear();
	}
}
