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
			// Claude 4+ deprecated `temperature` (Bedrock rejects requests that send it). Fail closed:
			// only known legacy shapes still accept it; new/unrecognized IDs get it omitted, which is
			// harmless, while sending it to a 4+ model fails every request.
			const isLegacyTemperatureModel = /claude-3[-.:]|claude-v2|claude-instant/.test(modelId);
			return {
				supportsToolChoice: true,
				toolResultFormat: 'text',
				supportsTemperature: isLegacyTemperatureModel,
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
