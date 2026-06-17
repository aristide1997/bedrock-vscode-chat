/**
 * Model profile system for handling provider-specific capabilities
 */

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
	 * Whether the model supports extended thinking / reasoning
	 * (Anthropic Claude 3.7+ and Claude 4 families on Bedrock)
	 */
	supportsThinking: boolean;
	/**
	 * Which reasoning request API the model expects:
	 * - 'effort':  newer adaptive API — `output_config: { effort }` (Opus 4.8, Sonnet 4.6+).
	 *              The model adapts its own thinking budget; we do NOT send budget_tokens.
	 * - 'budget':  legacy fixed API — `reasoning_config: { type: 'enabled', budget_tokens }`
	 *              (Claude 3.7, Claude 4.0/4.5).
	 * - 'none':    no reasoning support.
	 */
	reasoningApi: 'effort' | 'budget' | 'none';
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
		supportsThinking: false,
		reasoningApi: 'none',
	};

	// Split the model name into parts
	let parts = modelId.split('.');

	// Handle regional prefixes (e.g. "us.anthropic.claude-...")
	if (parts.length > 2 && parts[0].length === 2) {
		parts = parts.slice(1);
	}

	if (parts.length < 2) {
		return defaultProfile;
	}

	const provider = parts[0];

	// Provider-specific profiles
	switch (provider) {
		case 'anthropic': {
			// Claude 4+ models have deprecated the temperature parameter
			const isClaudeV4OrNewer = /claude-(opus|sonnet|haiku)-4/.test(modelId);
			// Extended thinking is supported on Claude 3.7 (Sonnet) and all Claude 4 families
			const supportsThinking = /claude-3-7/.test(modelId) || isClaudeV4OrNewer;
			// Newer models use the adaptive thinking API: `thinking: { type: "adaptive" }`
			// combined with `output_config: { effort }`, where the model chooses its own
			// thinking budget. This is recommended for Claude 4.6+ (e.g. Opus 4.6/4.7/4.8,
			// Sonnet 4.6). Older thinking models (Claude 3.7, Sonnet/Opus 4.0–4.5) use the
			// deprecated fixed `reasoning_config: { type: "enabled", budget_tokens }` API.
			const usesEffortApi =
				/claude-opus-4-([6-9]\d*)/.test(modelId) ||
				/claude-sonnet-4-([6-9]\d*)/.test(modelId) ||
				/claude-haiku-4-([6-9]\d*)/.test(modelId);
			const reasoningApi: ModelProfile['reasoningApi'] = !supportsThinking
				? 'none'
				: usesEffortApi
					? 'effort'
					: 'budget';
			return {
				supportsToolChoice: true,
				toolResultFormat: 'text',
				supportsTemperature: !isClaudeV4OrNewer,
				supportsThinking,
				reasoningApi,
			};
		}

		case 'mistral':
			// Mistral models require JSON format for tool results
			return {
				supportsToolChoice: false,
				toolResultFormat: 'json',
				supportsTemperature: true,
				supportsThinking: false,
				reasoningApi: 'none',
			};

		case 'amazon':
			// Amazon Nova models support tool choice
			if (modelId.includes('nova')) {
				return {
					supportsToolChoice: true,
					toolResultFormat: 'text',
					supportsTemperature: true,
					supportsThinking: false,
					reasoningApi: 'none',
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
