import * as vscode from "vscode";
import { BedrockChatProvider } from "./providers/bedrock-chat.provider";
import { ConfigurationService } from "./services/configuration.service";
import { AuthenticationService } from "./services/authentication.service";
import { manageSettings } from "./commands/manage-settings";
import {
	SELECT_THINKING_EFFORT_COMMAND,
	selectThinkingEffort,
	type EffortPickContext,
} from "./commands/select-thinking-effort";
import { getModelProfile } from "./profiles";
import { SHOW_CONFIGURATION_COMMAND, showConfiguration } from "./commands/show-configuration";
import { checkTokenSettings } from "./validation";
import { minMaxTokensForEffort } from "./converters/request";
import { showConfigurationProblem } from "./config-actions";
import { ThinkingStatusBar } from "./status-bar";
import { logger } from "./logger";

/**
 * Settings that change which models the picker should show. Only these warrant
 * firing the provider's refresh event, since doing so re-runs model discovery.
 */
const MODEL_LIST_SETTINGS = [
	"region",
	"authMethod",
	"manualModels",
	"inferenceProfileOverrides",
	"thinking.showEffortVariants",
	// Toggling the global default adds or removes the "· think off" variant, which
	// only exists to override a default that is on.
	"thinking.enabled",
];

/**
 * Settings whose values can make requests fail on their own, so they are
 * re-validated whenever one of them changes rather than only at startup.
 */
const TOKEN_LIMIT_SETTINGS = [
	"maxOutputTokens",
	"thinking.enabled",
	"thinking.effort",
	"thinking.budgetTokens",
];

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Bedrock Chat");
	logger.initialize(outputChannel, context.extensionMode);

	context.subscriptions.push(outputChannel);

	// Initialize services with dependency injection
	const configService = new ConfigurationService();
	const authService = new AuthenticationService(configService);
	const provider = new BedrockChatProvider(configService, authService);

	vscode.lm.registerLanguageModelChatProvider("bedrock", provider);
	context.subscriptions.push(provider);

	const statusBar = new ThinkingStatusBar(configService);
	context.subscriptions.push(statusBar);

	// The status bar can only report on limits once discovery has resolved them.
	context.subscriptions.push(
		provider.onDidCompleteDiscovery(() => {
			statusBar.setModelContext(pickEffortContext(provider));
		})
	);

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('languageModelChatProvider.bedrock')) {
				return;
			}
			const modelListChanged = MODEL_LIST_SETTINGS.some((key) =>
				e.affectsConfiguration(`languageModelChatProvider.bedrock.${key}`)
			);
			provider.handleConfigurationChange(modelListChanged);
			statusBar.refresh();
			if (TOKEN_LIMIT_SETTINGS.some((key) => e.affectsConfiguration(`languageModelChatProvider.bedrock.${key}`))) {
				void checkSettingsAdvisories(configService, context.globalState);
			}
		})
	);

	// A misconfigured token limit breaks every request, so say so at startup rather
	// than letting the first prompt of the session fail.
	void checkSettingsAdvisories(configService, context.globalState);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_THINKING_EFFORT_COMMAND, async () => {
			await selectThinkingEffort(configService, pickEffortContext(provider));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bedrock.manage", async () => {
			await manageSettings(context.secrets, context.globalState);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SHOW_CONFIGURATION_COMMAND, async () => {
			await showConfiguration({
				configService,
				authService,
				models: provider.models,
				extensionVersion: context.extension?.packageJSON?.version as string | undefined,
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bedrock.configure", async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'languageModelChatProvider.bedrock');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bedrock.selectModel", async () => {
			// Model selection is now built into VS Code's chat interface
			// This command provides guidance to users
			const action = await vscode.window.showInformationMessage(
				'Model selection is available in the VS Code chat interface. Click the model dropdown in the chat panel to select a Bedrock model.',
				'Open Chat Settings'
			);

			if (action === 'Open Chat Settings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'chat');
			}
		})
	);
}

export function deactivate() {}

/** globalState key holding the advisory IDs already shown to this user. */
const SHOWN_ADVISORIES_KEY = "bedrock.shownSettingsAdvisories";

/**
 * Warn about token-limit settings that are valid per the schema but will not work
 * in practice, at most once each.
 *
 * Once-only, keyed by the advisory's content: the same warning on every
 * activation would be noise, but a user who *changes* the setting to a different
 * bad value has made a new mistake and should hear about it. Re-checked on
 * configuration change for the same reason.
 */
async function checkSettingsAdvisories(
	configService: ConfigurationService,
	globalState: vscode.Memento
): Promise<void> {
	const enabled = configService.isThinkingEnabled();
	const effort = configService.getThinkingEffort();

	const advisories = checkTokenSettings({
		maxOutputTokens: configService.getMaxOutputTokens(),
		thinkingEnabled: enabled,
		thinkingEffort: effort,
		thinkingBudgetTokens: configService.getThinkingBudgetTokens(),
		requiredForEffort: enabled ? minMaxTokensForEffort(effort) : undefined,
	});

	if (advisories.length === 0) {
		return;
	}

	const shown = new Set(globalState.get<string[]>(SHOWN_ADVISORIES_KEY, []));
	// Only the first unseen advisory: stacking three notifications at startup
	// would be worse than the misconfiguration they describe.
	const advisory = advisories.find((a) => !shown.has(a.id));
	if (!advisory) {
		return;
	}

	shown.add(advisory.id);
	// Bounded, so a user who cycles through many values does not grow this forever.
	await globalState.update(SHOWN_ADVISORIES_KEY, [...shown].slice(-32));

	logger.warn(`[Settings] ${advisory.message}`);
	await showConfigurationProblem(
		advisory.message,
		["open-max-output-tokens", "change-effort", "show-configuration"],
		"warning"
	);
}

/**
 * Pick the model the effort quick pick should advise against.
 *
 * The quick pick sets a *global* default, so there is no single "current" model
 * to assess. The lowest discovered output ceiling is used deliberately: a level
 * that fits the smallest model fits all of them, so advice based on it is never
 * over-optimistic. Returns undefined before discovery has run, which makes the
 * quick pick fall back to listing levels without fit information rather than
 * blocking on a network call the user did not ask for.
 */
function pickEffortContext(provider: BedrockChatProvider): EffortPickContext | undefined {
	const ceilings = provider.models.getCeilings();
	if (ceilings.size === 0) {
		return undefined;
	}

	// Prefer a reasoning-capable model: assessing effort against one with no
	// thinking mode at all would be meaningless.
	const candidates = [...ceilings.entries()].filter(
		([id]) => getModelProfile(id).thinkingApi !== "none"
	);
	const pool = candidates.length > 0 ? candidates : [...ceilings.entries()];

	let chosen = pool[0];
	for (const entry of pool) {
		if (entry[1].maxOutputTokens < chosen[1].maxOutputTokens) {
			chosen = entry;
		}
	}

	return { modelId: chosen[0], ceiling: chosen[1].maxOutputTokens };
}
