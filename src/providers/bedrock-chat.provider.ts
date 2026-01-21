import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";
import { ModelService } from "../services/model.service";
import { AuthenticationService } from "../services/authentication.service";
import { ConfigurationService } from "../services/configuration.service";
import { ChatRequestHandler } from "./chat-request.handler";
import { TokenEstimator } from "./token.estimator";

/**
 * Main Bedrock chat provider that coordinates all operations.
 * Delegates to specialized handlers for specific functionality.
 */
export class BedrockChatProvider implements LanguageModelChatProvider {
	private modelService: ModelService;
	private chatRequestHandler: ChatRequestHandler;
	private tokenEstimator: TokenEstimator;

	constructor(
		private readonly configService: ConfigurationService,
		private readonly authService: AuthenticationService
	) {
		this.modelService = new ModelService(authService, configService);
		this.chatRequestHandler = new ChatRequestHandler(this.modelService, authService, configService);
		this.tokenEstimator = new TokenEstimator();
	}

	/**
	 * Handle configuration changes
	 */
	handleConfigurationChange(): void {
		this.modelService.handleConfigurationChange();
		this.chatRequestHandler.handleConfigurationChange();
	}

	/**
	 * Prepare language model chat information (called on startup)
	 */
	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.provideLanguageModelChatInformation(options, _token);
	}

	/**
	 * Provide language model chat information (called when user requests model list)
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return await this.modelService.getLanguageModelChatInformation(options.silent ?? false);
	}

	/**
	 * Process a chat request and stream the response
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		await this.chatRequestHandler.handleChatRequest(model, messages, options, progress, token);
	}

	/**
	 * Estimate token count for text or message
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken
	): Promise<number> {
		return this.tokenEstimator.estimateTokens(model, text);
	}
}
