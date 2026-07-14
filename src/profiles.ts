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
			const claudeVersionMatch = modelId.match(/claude-(?:opus|sonnet|haiku)-(\d+)/);
			const isClaudeV4OrNewer = claudeVersionMatch !== null && Number(claudeVersionMatch[1]) >= 4;
			return {
				supportsToolChoice: true,
				toolResultFormat: 'text',
				supportsTemperature: !isClaudeV4OrNewer,
			};
		}

		case 'mistral':
			// Mistral models require JSON format for tool results
			return {
				supportsToolChoice: false,
				toolResultFormat: 'json',
				supportsTemperature: true,
			};

		case 'amazon':
			// Amazon Nova models support tool choice
			if (modelId.includes('nova')) {
				return {
					supportsToolChoice: true,
					toolResultFormat: 'text',
					supportsTemperature: true,
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
