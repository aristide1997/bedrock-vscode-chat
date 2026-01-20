import * as vscode from "vscode";
import { BedrockChatModelProvider } from "./provider";
import { manageSettings } from "./commands/manage-settings";
import { logger } from "./logger";

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Bedrock Chat");
	logger.initialize(outputChannel, context.extensionMode);

	context.subscriptions.push(outputChannel);

	const ext = vscode.extensions.getExtension("arifum.bedrock-vscode-chat");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `bedrock-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const provider = new BedrockChatModelProvider(context.secrets, context.globalState, ua);
	vscode.lm.registerLanguageModelChatProvider("bedrock", provider);

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('languageModelChatProvider.bedrock')) {
				provider.handleConfigurationChange();
			}
		})
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand("bedrock.manage", async () => {
			await manageSettings(context.secrets, context.globalState);
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
