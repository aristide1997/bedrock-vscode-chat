import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import type { BedrockModelSummary, AuthConfig } from "./types";
import { logger } from "./logger";

export class BedrockAPIClient {
	private region: string;

	constructor(region: string) {
		this.region = region;
	}

	setRegion(region: string): void {
		this.region = region;
	}

	async fetchModels(authConfig: AuthConfig): Promise<BedrockModelSummary[]> {
		try {
			const credentials = this.getCredentials(authConfig);

			const client = new BedrockClient({
				region: this.region,
				credentials,
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

	async fetchInferenceProfiles(authConfig: AuthConfig): Promise<Set<string>> {
		try {
			const credentials = this.getCredentials(authConfig);

			const client = new BedrockClient({
				region: this.region,
				credentials,
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
		authConfig: AuthConfig,
		input: ConverseStreamCommandInput
	): Promise<AsyncIterable<any>> {
		const credentials = this.getCredentials(authConfig);

		const client = new BedrockRuntimeClient({
			region: this.region,
			credentials,
		});

		const command = new ConverseStreamCommand(input);
		const response = await client.send(command);

		if (!response.stream) {
			throw new Error("No stream in response");
		}

		return response.stream;
	}

	private getCredentials(authConfig: AuthConfig) {
		// Clean up API key environment variable if not using API key auth
		if (authConfig.method !== 'api-key') {
			delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		}

		if (authConfig.method === 'api-key') {
			if (!authConfig.apiKey) {
				throw new Error('API key is required for api-key authentication method');
			}
			process.env.AWS_BEARER_TOKEN_BEDROCK = authConfig.apiKey;
			return undefined;
		}

		if (authConfig.method === 'profile') {
			if (!authConfig.profile) {
				throw new Error('Profile name is required for profile authentication method');
			}
			return fromIni({ profile: authConfig.profile });
		}

		if (authConfig.method === 'access-keys') {
			if (!authConfig.accessKeyId || !authConfig.secretAccessKey) {
				throw new Error('Access key ID and secret access key are required for access-keys authentication method');
			}
			return {
				accessKeyId: authConfig.accessKeyId,
				secretAccessKey: authConfig.secretAccessKey,
				...(authConfig.sessionToken && { sessionToken: authConfig.sessionToken }),
			};
		}

		// 'default' method - use AWS SDK's default credential provider chain
		// This will check environment variables, EC2 instance metadata, etc.
		return undefined;
	}
}
