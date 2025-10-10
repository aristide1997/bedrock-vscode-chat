import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockModelSummary } from "./types";
import { logger } from "./logger";

export class BedrockAPIClient {
	private region: string;

	constructor(region: string) {
		this.region = region;
	}

	setRegion(region: string): void {
		this.region = region;
	}

	async fetchModels(apiKey: string): Promise<BedrockModelSummary[]> {
		try {
			process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey;

			const client = new BedrockClient({
				region: this.region,
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
			logger.error("[Bedrock API Client] Failed to fetch Bedrock models", err);
			throw err;
		}
	}

	async fetchInferenceProfiles(apiKey: string): Promise<Set<string>> {
		try {
			process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey;

			const client = new BedrockClient({
				region: this.region,
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
			logger.error("[Bedrock API Client] Failed to fetch inference profiles", err);
			return new Set();
		}
	}

	async startConversationStream(
		apiKey: string,
		input: ConverseStreamCommandInput
	): Promise<AsyncIterable<any>> {
		process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey;

		const client = new BedrockRuntimeClient({
			region: this.region,
		});

		const command = new ConverseStreamCommand(input);
		const response = await client.send(command);

		if (!response.stream) {
			throw new Error("No stream in response");
		}

		return response.stream;
	}
}
