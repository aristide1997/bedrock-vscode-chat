import type {
	BedrockContentBlock,
	BedrockMessage,
	BedrockSystemBlock,
	BedrockToolConfig,
} from "../types";
import type { ModelProfile } from "../profiles";

/**
 * Roughly how many tokens of prefix Bedrock needs before a cache checkpoint is
 * worth anything. Anthropic refuses to cache prefixes below ~1024 tokens, and a
 * refused checkpoint is billed as an ordinary (slightly more expensive) write,
 * so estimate first and skip when the conversation is still short.
 */
const MIN_CACHEABLE_TOKENS = 1024;

/** Deliberately crude: 4 characters per token, same heuristic as the estimator. */
const CHARS_PER_TOKEN = 4;

export interface CachePointInput {
	messages: BedrockMessage[];
	system: BedrockSystemBlock[];
	toolConfig?: BedrockToolConfig;
}

export interface CachePointResult extends CachePointInput {
	/** Number of cachePoint blocks actually inserted. */
	inserted: number;
}

const CACHE_POINT: BedrockContentBlock = { cachePoint: { type: "default" } };

function isCachePoint(block: unknown): boolean {
	return Boolean(block) && typeof block === "object" && "cachePoint" in (block as object);
}

function blockChars(block: BedrockContentBlock): number {
	if ("text" in block && typeof block.text === "string") {
		return block.text.length;
	}
	if ("toolUse" in block) {
		try {
			return JSON.stringify(block.toolUse).length;
		} catch {
			return 0;
		}
	}
	if ("toolResult" in block) {
		try {
			return JSON.stringify(block.toolResult).length;
		} catch {
			return 0;
		}
	}
	if ("reasoningContent" in block) {
		const rc = block.reasoningContent as { reasoningText?: { text?: string } };
		return rc.reasoningText?.text?.length ?? 0;
	}
	if ("image" in block) {
		// Images are billed per tile, not per character. Count them as a solid
		// chunk so an image-heavy prefix is not judged too small to cache.
		return 4000;
	}
	return 0;
}

/**
 * Insert Bedrock prompt-caching checkpoints into a request.
 *
 * Where the checkpoints go, and why:
 *
 * - **System prompt and tool schemas.** In an agent session these are large and
 *   byte-identical on every turn, so they are the highest-value checkpoints and
 *   cost one each.
 * - **The last two user messages.** This is what makes caching compound across a
 *   session rather than paying a write every turn for nothing. Turn N marks user
 *   messages U(n-1) and U(n); turn N+1 marks U(n) and U(n+1). The checkpoint at
 *   U(n) was written during turn N and is still present in turn N+1's prefix, so
 *   it reads back as a hit covering nearly the whole conversation. Marking only
 *   the newest message would write a cache entry that the next request, whose
 *   prefix has grown past it, could never read.
 *
 * Pure and total: returns fresh arrays and never mutates its input, so it is
 * unit-testable and cannot corrupt a request when caching is disabled.
 */
export function applyCachePoints(
	input: CachePointInput,
	profile: ModelProfile,
	enabled: boolean
): CachePointResult {
	if (!enabled || !profile.supportsPromptCaching || profile.maxCachePoints <= 0) {
		return { ...input, inserted: 0 };
	}

	let budget = profile.maxCachePoints;

	// Total prefix size decides whether any checkpoint can be honoured at all.
	const systemChars = input.system.reduce((sum, b) => sum + ("text" in b ? b.text.length : 0), 0);
	const toolChars = input.toolConfig ? safeStringifyLength(input.toolConfig.tools) : 0;
	const messageChars = input.messages.reduce(
		(sum, m) => sum + m.content.reduce((inner, b) => inner + blockChars(b), 0),
		0
	);
	const estimatedTokens = Math.ceil((systemChars + toolChars + messageChars) / CHARS_PER_TOKEN);

	if (estimatedTokens < MIN_CACHEABLE_TOKENS) {
		return { ...input, inserted: 0 };
	}

	let inserted = 0;

	// 1. Tool schemas. Cheapest win: identical on every request of a session.
	let toolConfig = input.toolConfig;
	if (toolConfig && toolConfig.tools.length > 0 && budget > 0 && !toolConfig.tools.some(isCachePoint)) {
		toolConfig = { ...toolConfig, tools: [...toolConfig.tools, { cachePoint: { type: "default" } }] };
		budget--;
		inserted++;
	}

	// 2. System prompt.
	let system = input.system;
	if (system.length > 0 && budget > 0 && !system.some(isCachePoint)) {
		system = [...system, { cachePoint: { type: "default" } }];
		budget--;
		inserted++;
	}

	// 3. The trailing pair of user messages, oldest first so ordering is stable.
	const messages = input.messages.map((m) => ({ ...m, content: [...m.content] }));
	const userIndices: number[] = [];
	for (let i = messages.length - 1; i >= 0 && userIndices.length < 2; i--) {
		if (messages[i].role === "user" && !messages[i].content.some(isCachePoint)) {
			userIndices.push(i);
		}
	}

	for (const idx of userIndices.reverse()) {
		if (budget <= 0) {
			break;
		}
		messages[idx].content.push(CACHE_POINT);
		budget--;
		inserted++;
	}

	return { messages, system, toolConfig, inserted };
}

function safeStringifyLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}
