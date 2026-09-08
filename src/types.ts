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

/**
 * Marks the end of a cacheable prefix. Everything before the block is eligible
 * for Bedrock prompt caching, so an identical prefix on a later request is
 * billed at the (much cheaper) cache-read rate instead of being re-processed.
 */
export interface BedrockCachePointBlock {
	cachePoint: {
		type: "default";
	};
}

/**
 * An assistant reasoning ("extended thinking") block. Bedrock returns these as
 * `reasoningText` with an opaque `signature`, or as `redactedContent` when the
 * reasoning was encrypted. Both must be replayed verbatim on later turns.
 */
export interface BedrockReasoningBlock {
	reasoningContent:
		| { reasoningText: { text: string; signature?: string } }
		| { redactedContent: Uint8Array };
}

export type BedrockContentBlock =
	| BedrockTextBlock
	| BedrockImageBlock
	| BedrockToolUseBlock
	| BedrockToolResultBlock
	| BedrockReasoningBlock
	| BedrockCachePointBlock;

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
export type BedrockSystemBlock = { text: string } | BedrockCachePointBlock;

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
	tools: Array<{ toolSpec: BedrockToolSpec } | BedrockCachePointBlock>;
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
 * A tool call whose streamed arguments never formed parseable JSON. Collected so
 * the request handler can tell the user *which* call was lost and why, instead of
 * the turn ending with no explanation.
 */
export interface ToolCallFailure {
	index: number;
	toolUseId?: string;
	name?: string;
	/** Length of everything that was received for the arguments. */
	argsLength: number;
	/** Leading fragment of the arguments, for diagnostics. */
	snippet: string;
}

/**
 * Token accounting returned by Bedrock on the `metadata` stream event.
 * The two cache fields are only present for models with prompt caching enabled.
 */
export interface BedrockUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheWriteInputTokens?: number;
}

/**
 * A single assistant reasoning block captured off the response stream, kept so
 * it can be replayed on the next turn (Bedrock requires it when extended
 * thinking is combined with tool use).
 */
export interface ReasoningBlock {
	text: string;
	signature?: string;
	redactedContent?: Uint8Array;
}

/**
 * Everything the stream processor learned while draining one Bedrock response.
 */
export interface StreamResult {
	/** Bedrock's reason for ending the turn, e.g. `end_turn`, `max_tokens`, `tool_use`. */
	stopReason?: string;
	usage?: BedrockUsage;
	latencyMs?: number;
	/** Tool calls whose arguments never parsed. Empty on a healthy stream. */
	toolCallFailures: ToolCallFailure[];
	emittedToolCalls: number;
	textLength: number;
	/** Reasoning blocks produced by this turn, in the order they arrived. */
	reasoning: ReasoningBlock[];
	/** IDs of the tool calls emitted from this turn. */
	toolUseIds: string[];
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
