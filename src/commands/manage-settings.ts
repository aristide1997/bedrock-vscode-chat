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
	const existingRegion = globalState.get<string>("bedrock.region") ?? "us-east-1";
	const existingAuthMethod = globalState.get<AuthMethod>("bedrock.authMethod") ?? "api-key";

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
		await handleAuthMethodSelection(secrets, globalState);
	} else if (action.value === "region") {
		const region = await vscode.window.showQuickPick(REGIONS, {
			title: "AWS Bedrock Region",
			placeHolder: `Current: ${existingRegion}`,
			ignoreFocusOut: true,
		});
		if (region) {
			await globalState.update("bedrock.region", region);
			vscode.window.showInformationMessage(`AWS Bedrock region set to ${region}.`);
		}
	} else if (action.value === "clear") {
		await clearAllSettings(secrets, globalState);
		vscode.window.showInformationMessage("AWS Bedrock settings cleared.");
	}
}

async function handleAuthMethodSelection(
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento
): Promise<void> {
	const method = await vscode.window.showQuickPick(
		[
			{ label: "API Key", value: "api-key", description: "Use AWS Bedrock API key (default)" },
			{ label: "AWS Profile", value: "profile", description: "Use AWS profile from ~/.aws/credentials" },
			{ label: "Access Keys", value: "access-keys", description: "Use AWS access key ID and secret" },
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

	await clearAuthSettings(secrets, globalState);
	await globalState.update("bedrock.authMethod", method.value);

	if (method.value === "api-key") {
		await handleApiKeySetup(secrets);
	} else if (method.value === "profile") {
		await handleProfileSetup(globalState);
	} else if (method.value === "access-keys") {
		await handleAccessKeysSetup(secrets);
	}
}

async function handleApiKeySetup(secrets: vscode.SecretStorage): Promise<void> {
	const apiKey = await vscode.window.showInputBox({
		title: "AWS Bedrock API Key",
		prompt: "Enter your AWS Bedrock API key",
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

	await secrets.store("bedrock.apiKey", apiKey.trim());
	vscode.window.showInformationMessage("AWS Bedrock API key saved.");
}

async function handleProfileSetup(globalState: vscode.Memento): Promise<void> {
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

	await globalState.update("bedrock.profile", profile.trim());
	vscode.window.showInformationMessage(`AWS profile set to '${profile.trim()}'.`);
}

async function handleAccessKeysSetup(secrets: vscode.SecretStorage): Promise<void> {
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

	await secrets.store("bedrock.accessKeyId", accessKeyId.trim());
	await secrets.store("bedrock.secretAccessKey", secretAccessKey.trim());

	if (sessionToken && sessionToken.trim()) {
		await secrets.store("bedrock.sessionToken", sessionToken.trim());
	}

	vscode.window.showInformationMessage("AWS access keys saved.");
}

async function clearAuthSettings(
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento
): Promise<void> {
	await secrets.delete("bedrock.apiKey");
	await secrets.delete("bedrock.accessKeyId");
	await secrets.delete("bedrock.secretAccessKey");
	await secrets.delete("bedrock.sessionToken");
	await globalState.update("bedrock.profile", undefined);
}

async function clearAllSettings(
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento
): Promise<void> {
	await clearAuthSettings(secrets, globalState);
	await globalState.update("bedrock.authMethod", undefined);
	await globalState.update("bedrock.region", undefined);
}
