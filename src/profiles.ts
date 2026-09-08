/**
 * Model profile system for handling provider-specific capabilities
 */

/**
 * Which shape of extended-thinking request the model accepts.
 * - `none`: the model has no reasoning mode.
 * - `budget`: legacy `reasoning_config: { type, budget_tokens }`.
 * - `adaptive`: `thinking: { type: "adaptive" }` plus `output_config.effort`.
 */
export type ThinkingApi = "none" | "budget" | "adaptive";

export interface ModelProfile {
	/**
	 * Whether the model supports the toolChoice parameter
	 */
	supportsToolChoice: boolean;
	/**
	 * Format to use for tool result content ('text' or 'json')
	 */
	toolResultFormat: 'text' | 'json';
	/**
	 * Whether the model supports the temperature inference parameter
	 * (Claude 4+ models have deprecated temperature)
	 */
	supportsTemperature: boolean;
	/**
	 * Which extended-thinking request shape the model accepts, if any.
	 */
	thinkingApi: ThinkingApi;
	/**
	 * Whether the model supports Bedrock prompt caching via cachePoint blocks.
	 */
	supportsPromptCaching: boolean;
	/**
	 * Maximum number of cachePoint blocks allowed in one request. 0 when caching
	 * is unsupported.
	 */
	maxCachePoints: number;
}

/**
 * Parse the major/minor version out of an Anthropic Claude model ID.
 *
 * Handles both naming generations, since Anthropic switched the order:
 *   claude-3-5-sonnet-20241022-v2:0  -> 3.5
 *   claude-3-7-sonnet-20250219-v1:0  -> 3.7
 *   claude-sonnet-4-20250514-v1:0    -> 4.0
 *   claude-sonnet-4-5-20250929-v1:0  -> 4.5
 *   claude-opus-4-8                  -> 4.8
 *   claude-sonnet-5                  -> 5.0
 *
 * Returns undefined when no version can be read, which callers treat as
 * "assume newest" so a model released after this code shipped is not denied
 * capabilities it has.
 */
export function parseClaudeVersion(modelId: string): { major: number; minor: number } | undefined {
	// New order: claude-<family>-<major>[-<minor>]
	const newStyle = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(modelId);
	if (newStyle) {
		return { major: Number(newStyle[1]), minor: newStyle[2] ? Number(newStyle[2]) : 0 };
	}

	// Old order: claude-<major>[-<minor>]-<family>
	const oldStyle = /claude-(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku)/.exec(modelId);
	if (oldStyle) {
		return { major: Number(oldStyle[1]), minor: oldStyle[2] ? Number(oldStyle[2]) : 0 };
	}

	return undefined;
}

/**
 * Which thinking API an Anthropic model on Bedrock speaks.
 *
 * Extended thinking arrived in Claude 3.7 with an explicit token budget. From
 * Claude 4.6 onward the adaptive API replaced it, where the caller states an
 * effort level and the model decides its own budget. Version-compared rather
 * than pattern-matched against a fixed list so future releases are covered.
 */
export function anthropicThinkingApi(modelId: string): ThinkingApi {
	// The pre-3 naming schemes carry no version to parse, and both predate
	// extended thinking by years. Recognizing them costs nothing in future-proofing
	// — the names are closed-ended and will not be reused — and it stops a
	// reasoning config being sent to a model that would reject the whole request.
	if (/claude-v2|claude-instant/.test(modelId)) {
		return "none";
	}

	const version = parseClaudeVersion(modelId);

	// Unknown version: assume a current model, which means the adaptive API.
	if (!version) {
		return "adaptive";
	}

	const { major, minor } = version;

	if (major > 4 || (major === 4 && minor >= 6)) {
		return "adaptive";
	}
	if (major === 4 || (major === 3 && minor >= 7)) {
		return "budget";
	}
	return "none";
}

/**
 * Get the model profile for a given Bedrock model ID
 * @param modelId The full Bedrock model ID (e.g., "anthropic.claude-3-5-sonnet-20241022-v2:0")
 * @returns Model profile with capabilities
 */
export function getModelProfile(modelId: string): ModelProfile {
	const defaultProfile: ModelProfile = {
		supportsToolChoice: false,
		toolResultFormat: 'text',
		supportsTemperature: true,
		thinkingApi: "none",
		supportsPromptCaching: false,
		maxCachePoints: 0,
	};

	// Split the model name into parts
	let parts = modelId.split('.');

	// Handle regional and cross-region routing prefixes
	// (e.g. "us.anthropic.claude-…", "global.anthropic.claude-…", "apac.…").
	if (parts.length > 2 && /^(?:[a-z]{2}|apac|global)$/i.test(parts[0])) {
		parts = parts.slice(1);
	}

	if (parts.length < 2) {
		return defaultProfile;
	}

	const provider = parts[0];

	// Provider-specific profiles
	switch (provider) {
		case 'anthropic': {
			// Claude 4+ deprecated `temperature` (Bedrock rejects requests that send it). Fail closed:
			// only known legacy shapes still accept it; new/unrecognized IDs get it omitted, which is
			// harmless, while sending it to a 4+ model fails every request.
			const isLegacyTemperatureModel = /claude-3[-.:]|claude-v2|claude-instant/.test(modelId);
			const version = parseClaudeVersion(modelId);
			// Prompt caching covers Claude 3.5 Sonnet v2 and newer. Fail closed on
			// anything older or unparseable so a cachePoint block never reaches a
			// model that would reject the whole request.
			const supportsPromptCaching = !version || version.major > 3 || (version.major === 3 && version.minor >= 5);
			return {
				supportsToolChoice: true,
				toolResultFormat: 'text',
				supportsTemperature: isLegacyTemperatureModel,
				thinkingApi: anthropicThinkingApi(modelId),
				supportsPromptCaching,
				// Anthropic allows at most 4 cache checkpoints per request.
				maxCachePoints: supportsPromptCaching ? 4 : 0,
			};
		}

		case 'mistral':
			// Mistral models require JSON format for tool results
			return {
				...defaultProfile,
				supportsToolChoice: false,
				toolResultFormat: 'json',
				supportsTemperature: true,
			};

		case 'amazon':
			// Amazon Nova models support tool choice
			if (modelId.includes('nova')) {
				// Nova supports prompt caching on the Converse API. Micro is excluded:
				// its context is too small for a cacheable prefix to pay off.
				const cacheable = !modelId.includes('nova-micro');
				return {
					...defaultProfile,
					supportsToolChoice: true,
					toolResultFormat: 'text',
					supportsTemperature: true,
					supportsPromptCaching: cacheable,
					maxCachePoints: cacheable ? 4 : 0,
				};
			}
			return defaultProfile;

		case 'cohere':
		case 'meta':
		case 'ai21':
			// Older models don't support tool choice
			return defaultProfile;

		default:
			return defaultProfile;
	}
}
