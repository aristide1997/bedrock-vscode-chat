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

	private readonly modelsChanged = new vscode.EventEmitter<void>();
	private readonly discoveryCompleted = new vscode.EventEmitter<void>();

	/**
	 * Tells VS Code the model list is stale and must be re-queried. Without it,
	 * turning the effort variants on or off would not change the picker until the
	 * window was reloaded.
	 */
	readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;

	/**
	 * Fires after model discovery resolves, so UI that depends on the discovered
	 * output ceilings can update.
	 *
	 * Separate from `onDidChangeLanguageModelChatInformation`, which is consumed by
	 * VS Code and re-triggers discovery — subscribing to that to learn discovery
	 * had finished would loop.
	 */
	readonly onDidCompleteDiscovery = this.discoveryCompleted.event;

	constructor(
		private readonly configService: ConfigurationService,
		private readonly authService: AuthenticationService
	) {
		this.modelService = new ModelService(authService, configService);
		this.chatRequestHandler = new ChatRequestHandler(this.modelService, authService, configService);
		this.tokenEstimator = new TokenEstimator();
	}

	/**
	 * The model service, for commands that need the discovered ceilings.
	 *
	 * Exposed rather than constructing a second ModelService in each command:
	 * discovery is two Bedrock list calls plus an OpenRouter lookup per model, and
	 * a separate instance would show ceilings that need not match the ones the
	 * request path is actually using.
	 */
	get models(): ModelService {
		return this.modelService;
	}

	/**
	 * Handle configuration changes.
	 *
	 * `modelListChanged` is passed in rather than inferred, because firing the
	 * refresh event re-runs model discovery: two Bedrock list calls plus an
	 * OpenRouter lookup per model. Changing the effort default from the status bar
	 * must not pay for that, so only settings that genuinely alter the list ask
	 * for a refresh.
	 */
	handleConfigurationChange(modelListChanged = false): void {
		this.modelService.handleConfigurationChange();
		this.chatRequestHandler.handleConfigurationChange();
		if (modelListChanged) {
			this.modelsChanged.fire();
		}
	}

	dispose(): void {
		this.modelsChanged.dispose();
		this.discoveryCompleted.dispose();
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
		const infos = await this.modelService.getLanguageModelChatInformation(options.silent ?? false);
		// Announce completion rather than have listeners poll: the discovered output
		// ceilings are not knowable until this resolves.
		this.discoveryCompleted.fire();
		return infos;
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
