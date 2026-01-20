import * as vscode from "vscode";
import type { AuthMethod } from "../types";

const REGIONS = [
	"us-east-1",
	"us-east-2",
	"us-west-2",
	"ap-south-1",
	"ap-northeast-1",
	"ap-northeast-2",
	"ap-southeast-1",
	"ap-southeast-2",
	"ca-central-1",
	"eu-central-1",
	"eu-west-1",
	"eu-west-2",
	"eu-west-3",
	"sa-east-1",
];

export async function manageSettings(
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento
): Promise<void> {
	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	const existingRegion = config.get<string>("region") ?? "us-east-1";
	const existingAuthMethod = config.get<AuthMethod>("authMethod") ?? "default";

	const action = await vscode.window.showQuickPick(
		[
			{ label: "Set Authentication Method", value: "auth-method", description: `Current: ${existingAuthMethod}` },
			{ label: "Set Region", value: "region", description: `Current: ${existingRegion}` },
			{ label: "Clear Settings", value: "clear" },
		],
		{
			title: "Manage AWS Bedrock Provider",
			placeHolder: "Choose an action",
		}
	);

	if (!action) {
		return;
	}

	if (action.value === "auth-method") {
		await handleAuthMethodSelection();
	} else if (action.value === "region") {
		const region = await vscode.window.showQuickPick(REGIONS, {
			title: "AWS Bedrock Region",
			placeHolder: `Current: ${existingRegion}`,
			ignoreFocusOut: true,
		});
		if (region) {
			await config.update("region", region, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`AWS Bedrock region set to ${region}.`);
		}
	} else if (action.value === "clear") {
		await clearAllSettings();
		vscode.window.showInformationMessage("AWS Bedrock settings cleared.");
	}
}

async function handleAuthMethodSelection(): Promise<void> {
	const method = await vscode.window.showQuickPick(
		[
			{ label: "API Key", value: "api-key", description: "Use AWS Bedrock API key (Bearer Token)" },
			{ label: "AWS Profile", value: "profile", description: "Use AWS profile from ~/.aws/credentials" },
			{ label: "Access Keys", value: "access-keys", description: "Use AWS access key ID and secret" },
			{ label: "Default", value: "default", description: "Use default AWS credential provider chain" },
		],
		{
			title: "Select Authentication Method",
			placeHolder: "Choose how to authenticate with AWS Bedrock",
			ignoreFocusOut: true,
		}
	);

	if (!method) {
		return;
	}

	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await clearAuthSettings();
	await config.update("authMethod", method.value, vscode.ConfigurationTarget.Global);

	if (method.value === "api-key") {
		await handleApiKeySetup();
	} else if (method.value === "profile") {
		await handleProfileSetup();
	} else if (method.value === "access-keys") {
		await handleAccessKeysSetup();
	} else if (method.value === "default") {
		vscode.window.showInformationMessage("Using default AWS credential provider chain.");
	}
}

async function handleApiKeySetup(): Promise<void> {
	const apiKey = await vscode.window.showInputBox({
		title: "AWS Bedrock API Key",
		prompt: "Enter your AWS Bedrock API key (starts with 'bedrock-api-key-')",
		ignoreFocusOut: true,
		password: true,
	});

	if (apiKey === undefined) {
		return;
	}

	if (!apiKey.trim()) {
		vscode.window.showWarningMessage("API key cannot be empty.");
		return;
	}

	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await config.update("apiKey", apiKey.trim(), vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage("AWS Bedrock API key saved.");
}

async function handleProfileSetup(): Promise<void> {
	const profile = await vscode.window.showInputBox({
		title: "AWS Profile",
		prompt: "Enter the AWS profile name from ~/.aws/credentials",
		ignoreFocusOut: true,
		placeHolder: "default",
	});

	if (profile === undefined) {
		return;
	}

	if (!profile.trim()) {
		vscode.window.showWarningMessage("Profile name cannot be empty.");
		return;
	}

	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await config.update("profile", profile.trim(), vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`AWS profile set to '${profile.trim()}'.`);
}

async function handleAccessKeysSetup(): Promise<void> {
	const accessKeyId = await vscode.window.showInputBox({
		title: "AWS Access Key ID",
		prompt: "Enter your AWS access key ID",
		ignoreFocusOut: true,
		password: true,
	});

	if (accessKeyId === undefined) {
		return;
	}

	if (!accessKeyId.trim()) {
		vscode.window.showWarningMessage("Access key ID cannot be empty.");
		return;
	}

	const secretAccessKey = await vscode.window.showInputBox({
		title: "AWS Secret Access Key",
		prompt: "Enter your AWS secret access key",
		ignoreFocusOut: true,
		password: true,
	});

	if (secretAccessKey === undefined) {
		return;
	}

	if (!secretAccessKey.trim()) {
		vscode.window.showWarningMessage("Secret access key cannot be empty.");
		return;
	}

	const sessionToken = await vscode.window.showInputBox({
		title: "AWS Session Token (Optional)",
		prompt: "Enter your AWS session token (leave empty if not needed)",
		ignoreFocusOut: true,
		password: true,
	});

	if (sessionToken === undefined) {
		return;
	}

	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await config.update("accessKeyId", accessKeyId.trim(), vscode.ConfigurationTarget.Global);
	await config.update("secretAccessKey", secretAccessKey.trim(), vscode.ConfigurationTarget.Global);

	if (sessionToken && sessionToken.trim()) {
		await config.update("sessionToken", sessionToken.trim(), vscode.ConfigurationTarget.Global);
	}

	vscode.window.showInformationMessage("AWS access keys saved.");
}

async function clearAuthSettings(): Promise<void> {
	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await config.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
	await config.update("accessKeyId", undefined, vscode.ConfigurationTarget.Global);
	await config.update("secretAccessKey", undefined, vscode.ConfigurationTarget.Global);
	await config.update("sessionToken", undefined, vscode.ConfigurationTarget.Global);
	await config.update("profile", undefined, vscode.ConfigurationTarget.Global);
}

async function clearAllSettings(): Promise<void> {
	await clearAuthSettings();
	const config = vscode.workspace.getConfiguration('languageModelChatProvider.bedrock');
	await config.update("authMethod", undefined, vscode.ConfigurationTarget.Global);
	await config.update("region", undefined, vscode.ConfigurationTarget.Global);
}
