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
		const region = this.getRegionFromConfig();
		this.client = new BedrockAPIClient(region);
		this.streamProcessor = new StreamProcessor();
	}

	/**
	 * Get region from configuration
	 */
	private getRegionFromConfig(): string {
		const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
		return config.get<string>('region') ?? "us-east-1";
	}

	/**
	 * Get thinking configuration from settings if enabled.
	 * Model capability check happens at request time via OpenRouter metadata.
	 */
	private getThinkingConfig(): { type: 'enabled' | 'disabled'; budget_tokens?: number } | undefined {
		const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
		const thinkingEnabled = config.get<boolean>('thinkingEnabled', false);

		if (!thinkingEnabled) {
			return undefined;
		}

		const thinkingBudgetTokens = config.get<number>('thinkingBudgetTokens', 1024);

		return {
			type: 'enabled',
			budget_tokens: Math.max(1024, thinkingBudgetTokens), // Minimum 1024 tokens
		};
	}

	/**
	 * Handle configuration changes
	 */
	handleConfigurationChange(): void {
		const region = this.getRegionFromConfig();
		this.client.setRegion(region);
		logger.log("[Bedrock Model Provider] Configuration changed, region updated to:", region);
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

		const region = this.getRegionFromConfig();
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

			const inferenceProfileId = `${regionPrefix}.${m.modelId}`;
			const hasInferenceProfile = availableProfileIds.has(inferenceProfileId);
			const modelIdToUse = hasInferenceProfile ? inferenceProfileId : m.modelId;

			// Try to get model properties from OpenRouter, fall back to defaults
			const properties = await this.client.getModelProperties(modelIdToUse);
			const maxInput = properties?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = properties?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
			const vision = m.inputModalities.includes("IMAGE");

			const modelInfo: LanguageModelChatInformation = {
				id: modelIdToUse,
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

			// Check if thinking is configured and model supports it
			const thinkingConfig = this.getThinkingConfig();
			const supportsThinking = thinkingConfig ? await this.client.supportsThinking(authConfig, model.id) : false;

			const requestInput: ConverseStreamCommandInput = {
				modelId: model.id,
				messages: converted.messages as any,
				inferenceConfig: {
					maxTokens: Math.min(options.modelOptions?.max_tokens || 4096, model.maxOutputTokens),
					// Temperature must be 1.0 when thinking is enabled, otherwise use user preference or default
					temperature: (thinkingConfig && supportsThinking) ? 1.0 : (options.modelOptions?.temperature ?? 0.7),
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

			if (thinkingConfig && supportsThinking) {
				requestInput.additionalModelRequestFields = {
					...(requestInput.additionalModelRequestFields as any),
					thinking: thinkingConfig,
				};
				logger.log("[Bedrock Model Provider] Extended thinking enabled with budget:", thinkingConfig.budget_tokens);
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

	/**
	 * Get authentication configuration from VS Code settings
	 */
	private async getAuthConfig(silent: boolean = false): Promise<AuthConfig | undefined> {
		const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
		const method = config.get<AuthMethod>('authMethod') ?? 'default';

		if (method === 'default') {
			// Use default credential provider chain
			return { method: 'default' };
		}

		if (method === 'api-key') {
			const apiKey = config.get<string>('apiKey');
			if (!apiKey && !silent) {
				vscode.window.showInformationMessage(
					'Please configure your AWS Bedrock API Key in settings or run "Configure AWS Bedrock".'
				);
				return undefined;
			}
			if (!apiKey) {
				return undefined;
			}
			return { method: 'api-key', apiKey };
		}

		if (method === 'profile') {
			const profile = config.get<string>('profile');
			if (!profile && !silent) {
				vscode.window.showInformationMessage(
					'Please configure your AWS profile in settings or run "Configure AWS Bedrock".'
				);
				return undefined;
			}
			if (!profile) {
				return undefined;
			}
			return { method: 'profile', profile };
		}

		if (method === 'access-keys') {
			const accessKeyId = config.get<string>('accessKeyId');
			const secretAccessKey = config.get<string>('secretAccessKey');
			const sessionToken = config.get<string>('sessionToken');

			if (!accessKeyId || !secretAccessKey) {
				if (!silent) {
					vscode.window.showInformationMessage(
						'Please configure your AWS access keys in settings or run "Configure AWS Bedrock".'
					);
				}
				return undefined;
			}

			return {
				method: 'access-keys',
				accessKeyId,
				secretAccessKey,
				...(sessionToken && { sessionToken }),
			};
		}

		return undefined;
	}
}
