import { logger } from "../logger";
import { CacheService } from "./cache.service";

interface OpenRouterModel {
	id: string;
	context_length?: number;
	top_provider?: {
		max_completion_tokens?: number;
	};
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
	 * Explicit Bedrock -> OpenRouter aliases for IDs whose normalized short forms
	 * differ. Keys are the *normalized* Bedrock short form (see normalizeModelId);
	 * values are the *normalized* OpenRouter short form to match against.
	 *
	 * Prefer to leave this empty and rely on normalizeModelId; add an entry only
	 * when a specific model is provably misidentified. Keeping the table small
	 * makes silent-fallback warnings actionable.
	 */
	private static readonly BEDROCK_TO_OPENROUTER_ALIASES: Record<string, string> = {};

	/**
	 * Normalize a model ID to a short, provider-agnostic form suitable for
	 * exact matching. Bedrock IDs carry region + provider prefixes and a date +
	 * version suffix that OpenRouter IDs never have; strip both so the two
	 * catalogues align.
	 *
	 *   us.anthropic.claude-opus-4-8-20250805-v1:0  ->  claude-opus-4-8
	 *   anthropic/claude-opus-4-8                    ->  claude-opus-4-8
	 */
	private normalizeModelId(modelId: string): string {
		let s = modelId
			.replace(/^(us|eu|ap|apac|global)\./i, '')
			.toLowerCase()
			.replace(/\./g, '-');
		// Bedrock date + version suffix (e.g. "-20250805-v1:0") or bare version ("-v1:0").
		// OpenRouter IDs never carry these, so stripping is safe.
		s = s.replace(/-\d{8}-v\d+(?::\d+)?$/, '');
		s = s.replace(/-v\d+(?::\d+)?$/, '');
		// Provider prefix: OpenRouter's cache keys already exclude it (see fetchMetadata),
		// but Bedrock IDs retain it. Strip a known-provider prefix so the two forms align.
		s = s.replace(/^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|stability|nova)-/, '');
		return s;
	}

	/**
	 * Find OpenRouter metadata for a given Bedrock model ID via exact-match on
	 * normalized short forms, with an alias table fallback. The prior
	 * bidirectional substring match let coarser catalogue entries (e.g.
	 * "claude-opus-4") match more specific models (e.g. "claude-opus-4-8"),
	 * with the winner decided by Map iteration order.
	 */
	private findMetadata(bedrockModelId: string): OpenRouterModel | undefined {
		const normalizedModelId = this.normalizeModelId(bedrockModelId);
		const alias = OpenRouterClient.BEDROCK_TO_OPENROUTER_ALIASES[normalizedModelId];
		const targets = alias ? [normalizedModelId, alias] : [normalizedModelId];

		const allMetadata = this.metadataCache.getAll();
		for (const [cachedId, metadata] of allMetadata) {
			const normalizedCachedId = this.normalizeModelId(cachedId);
			if (targets.includes(normalizedCachedId)) {
				return metadata;
			}
		}

		return undefined;
	}

	/**
	 * Get model properties (context length, max output tokens) from OpenRouter metadata
	 */
	async getModelProperties(modelId: string): Promise<{ contextLength?: number; maxOutputTokens?: number } | undefined> {
		await this.fetchMetadata();

		const metadata = this.findMetadata(modelId);
		if (!metadata) {
			// Warn (not log) so silent fallback to DEFAULT_CONTEXT_LENGTH /
			// DEFAULT_MAX_OUTPUT_TOKENS becomes visible when a new Bedrock model
			// lands before the OpenRouter catalogue picks it up.
			logger.warn(
				`[OpenRouter Client] No OpenRouter metadata found for ${modelId} — falling back to defaults`
			);
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
