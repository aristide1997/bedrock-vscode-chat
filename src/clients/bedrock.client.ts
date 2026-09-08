import { BedrockClient as AWSBedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
	CountTokensCommand,
	type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent as HttpsAgent } from "node:https";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";
import type { BedrockModelSummary } from "../types";
import { logger } from "../logger";

/**
 * A streaming turn can legitimately run for minutes with extended thinking and
 * a large output budget. The SDK's default request timeout is far too short for
 * that and shows up as a mid-stream socket error.
 */
const STREAMING_REQUEST_TIMEOUT_MS = 600_000;
/** Control-plane calls (model and profile listing) should fail fast. */
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;
/** TCP connect timeout, shared by both. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Let the SDK handle throttling itself. Adaptive mode applies jittered
 * exponential backoff with a client-side rate limiter, and because it retries
 * the initial request rather than a partly-consumed stream it cannot duplicate
 * output the way a hand-rolled retry around the stream loop does.
 */
const RETRY_MODE = "adaptive" as const;
const MAX_ATTEMPTS = 4;

export type CredentialInput = AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined;

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
	const proxyUrl =
		process.env.HTTPS_PROXY ??
		process.env.https_proxy ??
		process.env.HTTP_PROXY ??
		process.env.http_proxy;
	if (proxyUrl) {
		logger.log("[Bedrock Client] Routing requests through proxy:", proxyUrl);
		return new HttpsProxyAgent(proxyUrl);
	}
	return undefined;
}

/**
 * Request handlers are cached per timeout profile so the underlying HTTPS agent,
 * and therefore its keep-alive connection pool, is shared across every SDK
 * client this extension builds. The clients themselves are still created per
 * call: caching those would pin a stale credential provider or a stale Bedrock
 * API key from the environment.
 */
const handlerCache = new Map<string, NodeHttpHandler>();

function requestHandler(kind: "stream" | "control"): { requestHandler: NodeHttpHandler } {
	const cached = handlerCache.get(kind);
	if (cached) {
		return { requestHandler: cached };
	}

	const proxy = getProxyAgent();
	const requestTimeout = kind === "stream" ? STREAMING_REQUEST_TIMEOUT_MS : CONTROL_PLANE_REQUEST_TIMEOUT_MS;
	const handler = new NodeHttpHandler({
		requestTimeout,
		connectionTimeout: CONNECTION_TIMEOUT_MS,
		// A proxy agent replaces the default agent entirely; many corporate
		// proxies also break the SDK's HTTP/2 streaming, which NodeHttpHandler
		// avoids by using HTTP/1.1.
		httpsAgent: proxy ?? new HttpsAgent({ keepAlive: true, maxSockets: 50 }),
	});
	handlerCache.set(kind, handler);
	return { requestHandler: handler };
}

/** Test seam: drop cached request handlers so proxy settings are re-read. */
export function resetRequestHandlers(): void {
	handlerCache.clear();
}

/**
 * Models known not to support CountTokens.
 *
 * Without this, an unsupported model pays a failed round trip and logs a warning
 * on every single turn. One attempt is enough to learn the answer.
 */
const countTokensUnsupported = new Set<string>();

/** Test seam: forget which models were found not to support CountTokens. */
export function resetCountTokensSupport(): void {
	countTokensUnsupported.clear();
}

/**
 * Whether an error means the model or account will never answer this call, as
 * opposed to a transient fault worth retrying on the next turn.
 *
 * Exported for unit testing.
 */
export function isPermanentRejection(err: unknown): boolean {
	const name = err instanceof Error ? err.name : "";
	return (
		name === "ValidationException" ||
		name === "ResourceNotFoundException" ||
		name === "AccessDeniedException" ||
		name === "UnrecognizedClientException"
	);
}

/**
 * Pure AWS Bedrock API client.
 * Handles only AWS SDK interactions, no business logic or caching.
 */
export class BedrockClient {
	private region: string;

	constructor(region: string) {
		this.region = region;
	}

	setRegion(region: string): void {
		this.region = region;
	}

	private controlClient(credentials: CredentialInput): AWSBedrockClient {
		return new AWSBedrockClient({
			region: this.region,
			credentials,
			maxAttempts: MAX_ATTEMPTS,
			retryMode: RETRY_MODE,
			...requestHandler("control"),
		});
	}

	private runtimeClient(credentials: CredentialInput): BedrockRuntimeClient {
		return new BedrockRuntimeClient({
			region: this.region,
			credentials,
			maxAttempts: MAX_ATTEMPTS,
			retryMode: RETRY_MODE,
			...requestHandler("stream"),
		});
	}

	/**
	 * Fetch foundation models from AWS Bedrock
	 */
	async fetchModels(credentials: CredentialInput): Promise<BedrockModelSummary[]> {
		try {
			const client = this.controlClient(credentials);

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
			logger.error("[Bedrock Client] Failed to fetch Bedrock models", err);
			throw err;
		}
	}

	/**
	 * Fetch inference profiles from AWS Bedrock
	 */
	async fetchInferenceProfiles(credentials: CredentialInput): Promise<Set<string>> {
		try {
			const client = this.controlClient(credentials);

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
			logger.error("[Bedrock Client] Failed to fetch inference profiles", err);
			return new Set();
		}
	}

	/**
	 * Ask Bedrock to count the input tokens for a request using the model's own
	 * tokenizer.
	 *
	 * Worth the extra round trip because it is the only exact number available
	 * before sending: the character heuristic can be off by enough to either
	 * reject a request that would have fit or let one through that will not.
	 * Returns undefined when the model or region does not offer CountTokens, so
	 * the caller falls back to estimating. That verdict is remembered per model so
	 * an unsupported model is not re-probed on every turn.
	 */
	async countTokens(
		credentials: CredentialInput,
		modelId: string,
		input: {
			messages: ConverseStreamCommandInput["messages"];
			system?: ConverseStreamCommandInput["system"];
			toolConfig?: ConverseStreamCommandInput["toolConfig"];
		},
		abortSignal?: AbortSignal
	): Promise<number | undefined> {
		const supportKey = `${this.region}:${modelId}`;
		if (countTokensUnsupported.has(supportKey)) {
			return undefined;
		}

		try {
			const client = this.runtimeClient(credentials);
			const command = new CountTokensCommand({
				modelId,
				input: {
					converse: {
						messages: input.messages,
						...(input.system && input.system.length > 0 && { system: input.system }),
						...(input.toolConfig && { toolConfig: input.toolConfig }),
					},
				},
			});
			const response = await client.send(command, { abortSignal });
			return response.inputTokens ?? undefined;
		} catch (err) {
			// A cancelled request is not evidence about the model, so do not record it.
			if (abortSignal?.aborted) {
				return undefined;
			}
			// Only a permanent rejection means "this model cannot do it". Throttling
			// or a network blip must not disable accurate counting for the session.
			const permanent = isPermanentRejection(err);
			if (permanent) {
				countTokensUnsupported.add(supportKey);
			}
			logger.warn("[Bedrock Client] CountTokens unavailable, estimating instead", {
				modelId,
				region: this.region,
				permanent,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/**
	 * Start a conversation stream with AWS Bedrock.
	 *
	 * The abort signal is passed to the SDK so cancelling a chat request tears
	 * down the HTTP request instead of leaving it running while the loop stops
	 * reading, which kept burning output tokens after the user hit stop.
	 */
	async startConversationStream(
		credentials: CredentialInput,
		input: ConverseStreamCommandInput,
		abortSignal?: AbortSignal
	): Promise<AsyncIterable<ConverseStreamOutput>> {
		const client = this.runtimeClient(credentials);

		const command = new ConverseStreamCommand(input);
		const response = await client.send(command, { abortSignal });

		if (!response.stream) {
			throw new Error("No stream in response");
		}

		return response.stream;
	}
}
