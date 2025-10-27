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

	async fetchApplicationInferenceProfiles(authConfig: AuthConfig, foundationModels: BedrockModelSummary[]): Promise<BedrockModelSummary[]> {
		try {
			const credentials = this.getCredentials(authConfig);

			const client = new BedrockClient({
				region: this.region,
				credentials,
			});

			const command = new ListInferenceProfilesCommand({
				typeEquals: "APPLICATION",
			});
			const response = await client.send(command);

			const profiles: BedrockModelSummary[] = [];
			for (const profile of response.inferenceProfileSummaries ?? []) {
				if (profile.inferenceProfileId && profile.status === "ACTIVE") {
					// Extract foundation model identifier from the first model in the profile
					let matchedModel: BedrockModelSummary | undefined;

					if (profile.models && profile.models.length > 0) {
						const firstModelArn = profile.models[0].modelArn;
						if (firstModelArn) {
							// Extract the identifier after "foundation-model/"
							const match = firstModelArn.match(/foundation-model\/(.+)$/);
							if (match) {
								const identifier = `foundation-model/${match[1]}`;
								// Find the matching foundation model
								matchedModel = foundationModels.find(fm =>
									fm.modelArn.endsWith(identifier)
								);
							}
						}
					}

					profiles.push({
						modelArn: profile.inferenceProfileArn || "",
						modelId: profile.inferenceProfileArn || "",
						modelName: profile.inferenceProfileName || "",
						// Use foundation model properties if matched, otherwise use defaults
						providerName: matchedModel?.providerName || "Bedrock Application Inference Profile",
						inputModalities: matchedModel?.inputModalities || [],
						outputModalities: matchedModel?.outputModalities || [],
						responseStreamingSupported: matchedModel?.responseStreamingSupported || false,
						inferenceTypesSupported: matchedModel?.inferenceTypesSupported || [],
						modelLifecycle: matchedModel?.modelLifecycle || {status: ""},
					});
				}
			}

			return profiles;
		} catch (err) {
			logger.error("[Bedrock API Client] Failed to fetch application inference profiles", err);
			return [];
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
		if (authConfig.method === 'api-key') {
			process.env.AWS_BEARER_TOKEN_BEDROCK = authConfig.apiKey;
			return undefined;
		}

		delete process.env.AWS_BEARER_TOKEN_BEDROCK;

		if (authConfig.method === 'profile') {
			return fromIni({ profile: authConfig.profile });
		}

		if (authConfig.method === 'access-keys') {
			return {
				accessKeyId: authConfig.accessKeyId!,
				secretAccessKey: authConfig.secretAccessKey!,
				...(authConfig.sessionToken && { sessionToken: authConfig.sessionToken }),
			};
		}

		return undefined;
	}
}
