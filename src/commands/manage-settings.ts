import * as vscode from "vscode";

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
	const existingKey = await secrets.get("bedrock.apiKey");
	const existingRegion = globalState.get<string>("bedrock.region") ?? "us-east-1";

	const action = await vscode.window.showQuickPick(
		[
			{ label: "Set API Key", value: "key" },
			{ label: "Set Region", value: "region" },
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

	if (action.value === "key") {
		const apiKey = await vscode.window.showInputBox({
			title: "AWS Bedrock API Key",
			prompt: existingKey ? "Update your AWS Bedrock API key" : "Enter your AWS Bedrock API key",
			ignoreFocusOut: true,
			password: true,
			value: existingKey ?? "",
		});
		if (apiKey === undefined) {
			return;
		}
		if (!apiKey.trim()) {
			await secrets.delete("bedrock.apiKey");
			vscode.window.showInformationMessage("AWS Bedrock API key cleared.");
			return;
		}
		await secrets.store("bedrock.apiKey", apiKey.trim());
		vscode.window.showInformationMessage("AWS Bedrock API key saved.");
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
		await secrets.delete("bedrock.apiKey");
		await globalState.update("bedrock.region", undefined);
		vscode.window.showInformationMessage("AWS Bedrock settings cleared.");
	}
}
