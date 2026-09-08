import * as vscode from "vscode";
import { logger } from "./logger";
import {
	MAX_OUTPUT_TOKENS_SETTING,
	THINKING_EFFORT_SETTING,
	THINKING_BUDGET_SETTING,
} from "./validation";

/** Actions a configuration problem can offer. */
export type ConfigFixAction =
	| "open-max-output-tokens"
	| "open-thinking-budget"
	| "open-thinking-effort"
	| "change-effort"
	| "open-all-settings"
	| "manage-provider"
	| "show-configuration"
	| "show-logs";

interface ActionSpec {
	label: string;
	run: () => Thenable<unknown>;
}

const ALL_SETTINGS = "languageModelChatProvider.bedrock";

/**
 * The single place a configuration problem is turned into buttons.
 *
 * Previously only the output-token conflict offered a way to act on itself, so
 * an auth or region failure left the user to guess which of a dozen settings to
 * search for. Centralizing the mapping keeps every configuration error equally
 * actionable, and means a new error site gets the behaviour by naming an action
 * rather than by reimplementing the plumbing.
 */
const ACTIONS: Record<ConfigFixAction, ActionSpec> = {
	"open-max-output-tokens": {
		label: "Open Output Limit Setting",
		run: () => vscode.commands.executeCommand("workbench.action.openSettings", MAX_OUTPUT_TOKENS_SETTING),
	},
	"open-thinking-budget": {
		label: "Open Thinking Budget Setting",
		run: () => vscode.commands.executeCommand("workbench.action.openSettings", THINKING_BUDGET_SETTING),
	},
	"open-thinking-effort": {
		label: "Open Thinking Effort Setting",
		run: () => vscode.commands.executeCommand("workbench.action.openSettings", THINKING_EFFORT_SETTING),
	},
	"change-effort": {
		label: "Change Thinking Effort",
		run: () => vscode.commands.executeCommand("bedrock.selectThinkingEffort"),
	},
	"open-all-settings": {
		label: "Open Bedrock Settings",
		run: () => vscode.commands.executeCommand("workbench.action.openSettings", ALL_SETTINGS),
	},
	"manage-provider": {
		label: "Configure Authentication",
		run: () => vscode.commands.executeCommand("bedrock.manage"),
	},
	"show-configuration": {
		label: "Show Effective Configuration",
		run: () => vscode.commands.executeCommand("bedrock.showConfiguration"),
	},
	"show-logs": {
		label: "Show Logs",
		run: () => {
			logger.show();
			return Promise.resolve();
		},
	},
};

/**
 * Show a configuration problem with the actions that can resolve it.
 *
 * Capped at three buttons because VS Code collapses the rest behind an overflow
 * menu, which defeats the point of offering them.
 */
export async function showConfigurationProblem(
	message: string,
	actions: readonly ConfigFixAction[],
	severity: "error" | "warning" = "error"
): Promise<void> {
	const specs = actions.slice(0, 3).map((a) => ACTIONS[a]);
	const labels = specs.map((s) => s.label);

	const choice =
		severity === "error"
			? await vscode.window.showErrorMessage(message, ...labels)
			: await vscode.window.showWarningMessage(message, ...labels);

	if (!choice) {
		return;
	}
	const spec = specs.find((s) => s.label === choice);
	if (spec) {
		await spec.run();
	}
}

/**
 * Classify an error message and offer the actions that fit it.
 *
 * Returns true when the error was recognized as a configuration problem, so the
 * caller can skip its own generic reporting.
 */
export async function reportConfigurationError(message: string): Promise<boolean> {
	const lower = message.toLowerCase();

	// Credentials: missing, malformed, expired or refused.
	if (
		lower.includes("not configured") ||
		lower.includes("credential") ||
		lower.includes("accessdenied") ||
		lower.includes("unrecognizedclient") ||
		lower.includes("invalid api key") ||
		lower.includes("expired") ||
		lower.includes("unauthorized") ||
		lower.includes("securitytoken")
	) {
		await showConfigurationProblem(
			`Bedrock authentication failed: ${message}`,
			["manage-provider", "show-configuration", "show-logs"]
		);
		return true;
	}

	// A model or endpoint that does not exist in the configured region is far more
	// often a wrong region than a wrong model, so lead with the region.
	if (
		lower.includes("could not connect to the endpoint") ||
		lower.includes("resourcenotfound") ||
		lower.includes("is not available in") ||
		lower.includes("invalid region") ||
		lower.includes("enotfound")
	) {
		await showConfigurationProblem(
			`Bedrock could not be reached in the configured region: ${message}`,
			["open-all-settings", "show-configuration", "show-logs"]
		);
		return true;
	}

	// Model access that has not been requested in the AWS console. Nothing in the
	// extension can fix it, so point at the diagnostics rather than a setting.
	if (lower.includes("don't have access") || lower.includes("model access") || lower.includes("not authorized to invoke")) {
		await showConfigurationProblem(
			`This model is not enabled for your AWS account: ${message}`,
			["show-configuration", "manage-provider", "show-logs"]
		);
		return true;
	}

	return false;
}

/** The setting-opening action for a message that mentions the output limit. */
export function actionsForTokenLimit(limitedBySetting: boolean): ConfigFixAction[] {
	return limitedBySetting
		? ["open-max-output-tokens", "change-effort", "show-configuration"]
		: ["change-effort", "show-configuration", "show-logs"];
}
