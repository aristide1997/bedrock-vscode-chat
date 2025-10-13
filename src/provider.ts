import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";
import { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockAPIClient } from "./bedrock-client";
import { StreamProcessor } from "./stream-processor";
import { convertMessages } from "./converters/messages";
import { convertTools } from "./converters/tools";
import { validateRequest } from "./validation";
import { logger } from "./logger";
import type { AuthConfig, AuthMethod } from "./types";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_CONTEXT_LENGTH = 200000;

export class BedrockChatModelProvider implements LanguageModelChatProvider {
	private client: BedrockAPIClient;
	private streamProcessor: StreamProcessor;
	private chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly globalState: vscode.Memento,
		private readonly userAgent: string
	) {
		const region = this.globalState.get<string>("bedrock.region") ?? "us-east-1";
		this.client = new BedrockAPIClient(region);
		this.streamProcessor = new StreamProcessor();
	}

	private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += Math.ceil(part.value.length / 4);
				}
			}
		}
		return total;
	}

	private estimateToolTokens(
		toolConfig: { tools: Array<{ toolSpec: { name: string; description?: string; inputSchema: { json: object } } }> } | undefined
	): number {
		if (!toolConfig || toolConfig.tools.length === 0) {
			return 0;
		}
		try {
			const json = JSON.stringify(toolConfig);
			return Math.ceil(json.length / 4);
		} catch {
			return 0;
		}
	}

	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.provideLanguageModelChatInformation(options, _token);
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const authConfig = await this.getAuthConfig(options.silent ?? false);
		if (!authConfig) {
			return [];
		}

		const region = this.globalState.get<string>("bedrock.region") ?? "us-east-1";
		this.client.setRegion(region);

		let models, availableProfileIds;
		try {
			[models, availableProfileIds] = await Promise.all([
				this.client.fetchModels(authConfig),
				this.client.fetchInferenceProfiles(authConfig),
			]);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Bedrock Model Provider] Failed to fetch models", err);
			if (!options.silent) {
				vscode.window.showErrorMessage(`Failed to fetch Bedrock models: ${errorMsg}`);
			}
			return [];
		}

		const infos: LanguageModelChatInformation[] = [];
		const regionPrefix = region.split("-")[0];

		for (const m of models) {
			if (!m.responseStreamingSupported || !m.outputModalities.includes("TEXT")) {
				continue;
			}

			const contextLen = DEFAULT_CONTEXT_LENGTH;
			const maxOutput = DEFAULT_MAX_OUTPUT_TOKENS;
			const maxInput = Math.max(1, contextLen - maxOutput);
			const vision = m.inputModalities.includes("IMAGE");

			const inferenceProfileId = `${regionPrefix}.${m.modelId}`;
			const hasInferenceProfile = availableProfileIds.has(inferenceProfileId);

			const modelInfo: LanguageModelChatInformation = {
				id: hasInferenceProfile ? inferenceProfileId : m.modelId,
				name: m.modelName,
				tooltip: `AWS Bedrock - ${m.providerName}${hasInferenceProfile ? ' (Cross-Region)' : ''}`,
				detail: `${m.providerName} • ${hasInferenceProfile ? 'Multi-Region' : region}`,
				family: "bedrock",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: {
					toolCalling: true,
					imageInput: vision,
				},
			};
			infos.push(modelInfo);
		}

		this.chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		return infos;
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					logger.error("[Bedrock Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};

		try {
			const authConfig = await this.getAuthConfig();
			if (!authConfig) {
				throw new Error("Bedrock authentication not configured");
			}

			logger.log("[Bedrock Model Provider] Converting messages, count:", messages.length);
			messages.forEach((msg, idx) => {
				const partTypes = msg.content.map(p => {
					if (p instanceof vscode.LanguageModelTextPart) return 'text';
					if (p instanceof vscode.LanguageModelToolCallPart) return 'toolCall';
					if (typeof p === 'object' && p !== null && 'mimeType' in p && (p as any).mimeType?.startsWith('image/')) return 'image';
					return 'toolResult';
				});
				logger.log(`[Bedrock Model Provider] Message ${idx} (${msg.role}):`, partTypes);
			});

			const converted = convertMessages(messages, model.id);
			validateRequest(messages);

			logger.log("[Bedrock Model Provider] Converted to Bedrock messages:", converted.messages.length);
			converted.messages.forEach((msg, idx) => {
				const contentTypes = msg.content.map(c => {
					if ('text' in c) return 'text';
					if ('image' in c) return 'image';
					if ('toolUse' in c) return 'toolUse';
					return 'toolResult';
				});
				logger.log(`[Bedrock Model Provider] Bedrock message ${idx} (${msg.role}):`, contentTypes);
			});

			const toolConfig = convertTools(options, model.id);

			if (options.tools && options.tools.length > 128) {
				throw new Error("Cannot have more than 128 tools per request.");
			}

			const inputTokenCount = this.estimateMessagesTokens(messages);
			const toolTokenCount = this.estimateToolTokens(toolConfig);
			const tokenLimit = Math.max(1, model.maxInputTokens);
			if (inputTokenCount + toolTokenCount > tokenLimit) {
				logger.error("[Bedrock Model Provider] Message exceeds token limit", {
					total: inputTokenCount + toolTokenCount,
					tokenLimit,
				});
				throw new Error("Message exceeds token limit.");
			}

			const requestInput: ConverseStreamCommandInput = {
				modelId: model.id,
				messages: converted.messages as any,
				inferenceConfig: {
					maxTokens: Math.min(options.modelOptions?.max_tokens || 4096, model.maxOutputTokens),
					temperature: options.modelOptions?.temperature ?? 0.7,
				},
			};

			if (converted.system.length > 0) {
				requestInput.system = converted.system as any;
			}

			if (options.modelOptions) {
				const mo = options.modelOptions as Record<string, unknown>;
				if (typeof mo.top_p === "number") {
					requestInput.inferenceConfig!.topP = mo.top_p;
				}
				if (typeof mo.stop === "string") {
					requestInput.inferenceConfig!.stopSequences = [mo.stop];
				} else if (Array.isArray(mo.stop)) {
					requestInput.inferenceConfig!.stopSequences = mo.stop;
				}
			}

			if (toolConfig) {
				requestInput.toolConfig = toolConfig as any;
			}

			logger.log("[Bedrock Model Provider] Starting streaming request");
			const stream = await this.client.startConversationStream(authConfig, requestInput);

			logger.log("[Bedrock Model Provider] Processing stream events");
			await this.streamProcessor.processStream(stream, trackingProgress, token);
			logger.log("[Bedrock Model Provider] Finished processing stream");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Bedrock Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			vscode.window.showErrorMessage(`Bedrock chat request failed: ${errorMsg}`);
			throw err;
		}
	}

	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / 4);
				}
			}
			return totalTokens;
		}
	}

	private async getAuthConfig(silent: boolean = false): Promise<AuthConfig | undefined> {
		const method = this.globalState.get<AuthMethod>("bedrock.authMethod") ?? "api-key";

		if (method === "api-key") {
			let apiKey = await this.secrets.get("bedrock.apiKey");
			if (!apiKey && !silent) {
				const entered = await vscode.window.showInputBox({
					title: "AWS Bedrock API Key",
					prompt: "Enter your AWS Bedrock API key",
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store("bedrock.apiKey", apiKey);
				}
			}
			if (!apiKey) {
				return undefined;
			}
			return { method: "api-key", apiKey };
		}

		if (method === "profile") {
			const profile = this.globalState.get<string>("bedrock.profile");
			if (!profile) {
				if (!silent) {
					vscode.window.showErrorMessage("AWS profile not configured. Please run 'Manage AWS Bedrock Provider'.");
				}
				return undefined;
			}
			return { method: "profile", profile };
		}

		if (method === "access-keys") {
			const accessKeyId = await this.secrets.get("bedrock.accessKeyId");
			const secretAccessKey = await this.secrets.get("bedrock.secretAccessKey");
			const sessionToken = await this.secrets.get("bedrock.sessionToken");

			if (!accessKeyId || !secretAccessKey) {
				if (!silent) {
					vscode.window.showErrorMessage("AWS access keys not configured. Please run 'Manage AWS Bedrock Provider'.");
				}
				return undefined;
			}

			return {
				method: "access-keys",
				accessKeyId,
				secretAccessKey,
				...(sessionToken && { sessionToken }),
			};
		}

		return undefined;
	}
}
