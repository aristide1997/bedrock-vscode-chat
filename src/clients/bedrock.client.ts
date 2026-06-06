import { BedrockClient as AWSBedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";
import type { BedrockModelSummary } from "../types";
import { logger } from "../logger";

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
 * Build the AWS client requestHandler override.
 * Only when a proxy is configured do we install a NodeHttpHandler (which routes
 * through the proxy agent and uses HTTP/1.1 — many corporate proxies break the
 * SDK's default HTTP/2 streaming). With no proxy we return nothing so the SDK
 * keeps its default behavior for everyone else.
 */
function proxyRequestHandler(): { requestHandler?: NodeHttpHandler } {
	const agent = getProxyAgent();
	return agent ? { requestHandler: new NodeHttpHandler({ httpsAgent: agent }) } : {};
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

	/**
	 * Fetch foundation models from AWS Bedrock
	 */
	async fetchModels(credentials: AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined): Promise<BedrockModelSummary[]> {
		try {
			const client = new AWSBedrockClient({
				region: this.region,
				credentials,
				...proxyRequestHandler(),
			});

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
	async fetchInferenceProfiles(credentials: AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined): Promise<Set<string>> {
		try {
			const client = new AWSBedrockClient({
				region: this.region,
				credentials,
				...proxyRequestHandler(),
			});

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
	 * Start a conversation stream with AWS Bedrock
	 */
	async startConversationStream(
		credentials: AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined,
		input: ConverseStreamCommandInput
	): Promise<AsyncIterable<any>> {
		const client = new BedrockRuntimeClient({
			region: this.region,
			credentials,
			...proxyRequestHandler(),
		});

		const command = new ConverseStreamCommand(input);
		const response = await client.send(command);

		if (!response.stream) {
			throw new Error("No stream in response");
		}

		return response.stream;
	}
}
