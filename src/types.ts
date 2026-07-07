/**
 * Bedrock Converse API message content block types.
 */
export interface BedrockTextBlock {
	text: string;
}

export interface BedrockToolUseBlock {
	toolUse: {
		toolUseId: string;
		name: string;
		input: Record<string, unknown>;
	};
}

export interface BedrockToolResultBlock {
	toolResult: {
		toolUseId: string;
		content: Array<{ text: string } | { json: Record<string, unknown> }>;
		status?: "success" | "error";
	};
}

export interface BedrockImageBlock {
	image: {
		format: "png" | "jpeg" | "gif" | "webp";
		source: {
			bytes: Uint8Array;
		};
	};
}

export type BedrockContentBlock = BedrockTextBlock | BedrockImageBlock | BedrockToolUseBlock | BedrockToolResultBlock;

/**
 * Bedrock Converse API message structure.
 */
export interface BedrockMessage {
	role: "user" | "assistant";
	content: BedrockContentBlock[];
}

/**
 * Bedrock system message structure.
 */
export interface BedrockSystemBlock {
	text: string;
}

/**
 * Bedrock tool specification.
 */
export interface BedrockToolSpec {
	name: string;
	description?: string;
	inputSchema: {
		json: Record<string, unknown>;
	};
}

/**
 * Bedrock tool configuration.
 */
export interface BedrockToolConfig {
	tools: Array<{
		toolSpec: BedrockToolSpec;
	}>;
	toolChoice?: {
		auto?: Record<string, never>;
		any?: Record<string, never>;
		tool?: {
			name: string;
		};
	};
}

/**
 * Bedrock foundation model information.
 */
export interface BedrockModelSummary {
	modelArn: string;
	modelId: string;
	modelName: string;
	providerName: string;
	inputModalities: string[];
	outputModalities: string[];
	responseStreamingSupported: boolean;
	customizationsSupported?: string[];
	inferenceTypesSupported?: string[];
	modelLifecycle?: {
		status?: string;
	};
}

/**
 * Buffer used to accumulate streamed tool call parts until complete.
 */
export interface ToolCallBuffer {
	id?: string;
	name?: string;
	args: string;
}

/**
 * A manually-declared Bedrock model. Used when the environment blocks
 * bedrock:ListFoundationModels / ListInferenceProfiles (e.g. a restrictive
 * Service Control Policy) but still permits Converse/InvokeModel, or when a
 * user simply wants to pin an explicit set of models.
 */
export interface ManualModel {
	/** Bare model ID, e.g. "anthropic.claude-opus-4-8". */
	id: string;
	/** Display name shown in the picker. Defaults to `id`. */
	name?: string;
	/**
	 * Inference profile ID or ARN to invoke instead of the bare ID
	 * (e.g. "global.anthropic.claude-opus-4-8"). Most cross-region models
	 * require this. Equivalent to an entry in `inferenceProfileOverrides`.
	 */
	inferenceProfile?: string;
	/** Whether the model accepts image input. Defaults to false. */
	vision?: boolean;
	/** Optional context-window override (input tokens). */
	maxInputTokens?: number;
	/** Optional max output tokens. */
	maxOutputTokens?: number;
}

/**
 * Authentication method for AWS Bedrock.
 */
export type AuthMethod = 'api-key' | 'profile' | 'access-keys' | 'default';

/**
 * Authentication configuration for AWS Bedrock.
 */
export interface AuthConfig {
	method: AuthMethod;
	apiKey?: string;
	profile?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}
