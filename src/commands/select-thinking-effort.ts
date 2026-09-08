import * as vscode from "vscode";
import type { ThinkingEffort } from "../converters/request";
import { budgetForEffort } from "../converters/request";
import { THINKING_EFFORTS } from "../thinking-variants";
import { getModelProfile } from "../profiles";
import {
	assessAllEfforts,
	describeAvailability,
	detailForAvailability,
	iconForAvailability,
	type EffortAvailability,
} from "../effort-availability";
import { ConfigurationService } from "../services/configuration.service";
import { MAX_OUTPUT_TOKENS_SETTING } from "../validation";

export const SELECT_THINKING_EFFORT_COMMAND = "bedrock.selectThinkingEffort";

interface EffortItem extends vscode.QuickPickItem {
	/** The level to apply, or "off" to disable thinking entirely. */
	value?: ThinkingEffort | "off";
	/** Set on the entry that toggles the model-picker variants instead. */
	toggleVariants?: boolean;
	/** Set on the entry that opens the output-token setting. */
	openMaxTokens?: boolean;
	/** Availability, when this row is an effort level. */
	availability?: EffortAvailability;
}

/**
 * What the quick pick needs to know about the model it is advising on.
 *
 * Passed in rather than looked up, so the command has no dependency on model
 * discovery having completed. When it is absent the levels are still listed,
 * just without fit information — an advisory panel must never be the reason a
 * user cannot change a setting.
 */
export interface EffortPickContext {
	modelId: string;
	ceiling: number;
}

/**
 * Quick pick for the global reasoning-effort default, opened from the status bar.
 *
 * Writes the same two settings the settings page exposes rather than keeping its
 * own copy of the state, so the status bar, the settings editor and the request
 * builder can never disagree about the current default.
 *
 * Levels that cannot work with the current output-token limit are marked and
 * refuse to be selected. Letting one be picked and failing at request time is
 * strictly worse: by then the user has written a prompt and lost a turn to a
 * combination that was known to be invalid before they chose it.
 */
export async function selectThinkingEffort(
	configService: ConfigurationService,
	context?: EffortPickContext
): Promise<void> {
	const enabled = configService.isThinkingEnabled();
	const current: ThinkingEffort | "off" = enabled ? configService.getThinkingEffort() : "off";
	const variantsShown = configService.showEffortVariants();
	const settingMaxTokens = configService.getMaxOutputTokens();
	const budgetTokens = configService.getThinkingBudgetTokens();
	const tick = new vscode.ThemeIcon("check");

	const availability = context
		? assessAllEfforts({
				ceiling: context.ceiling,
				settingMaxTokens,
				budgetTokens,
				api: getModelProfile(context.modelId).thinkingApi === "budget" ? "budget" : "adaptive",
			})
		: undefined;

	const byEffort = new Map(availability?.map((a) => [a.effort, a]) ?? []);

	const items: EffortItem[] = [
		{
			label: "off",
			description: "no reasoning — fastest and cheapest",
			value: "off",
			iconPath: current === "off" ? tick : undefined,
		},
		...THINKING_EFFORTS.map((effort): EffortItem => {
			const a = byEffort.get(effort);
			const icon = a ? iconForAvailability(a) : undefined;
			return {
				label: effort,
				description: a
					? describeAvailability(a)
					: `${budgetForEffort(effort).toLocaleString("en-US")}-token budget`,
				detail: a ? detailForAvailability(a) : undefined,
				value: effort,
				availability: a,
				// A tick for the active level takes precedence: the user needs to see
				// what is currently set even when it has since become unusable.
				iconPath: current === effort ? tick : icon ? new vscode.ThemeIcon(icon) : undefined,
			};
		}),
		{ label: "", kind: vscode.QuickPickItemKind.Separator },
		{
			label: "Show effort variants in the model picker",
			description: variantsShown ? "on — click to turn off" : "off — click to turn on",
			detail:
				"Adds a per-effort entry for each reasoning model, so effort can be set per conversation — " +
				"including a `think off` entry, the only way to disable reasoning for a single chat.",
			toggleVariants: true,
			iconPath: variantsShown ? tick : undefined,
		},
	];

	// Only offer the escape hatch when a setting is actually what constrains it.
	const blocked = availability?.filter((a) => a.fit !== "fits" && a.limitedBySetting) ?? [];
	if (blocked.length > 0) {
		items.push({
			label: "Open the output-token limit setting",
			description: `currently ${settingMaxTokens?.toLocaleString("en-US") ?? "unset"}`,
			detail: "Set it to 0 to use each model's own maximum, which makes every effort level usable.",
			openMaxTokens: true,
			iconPath: new vscode.ThemeIcon("gear"),
		});
	}

	const pick = await vscode.window.showQuickPick(items, {
		title: context ? `Bedrock: thinking effort — ${context.modelId}` : "Bedrock: thinking effort",
		// The token budget shown against each level only applies to the older
		// budget-based API; say so here rather than repeating it on every row.
		placeHolder: availability
			? "Reasoning tokens are spent out of the output-token limit"
			: "Claude 4.6 and newer choose their own budget from the level; Claude 3.7–4.5 get the budget shown",
	});

	if (!pick) {
		return;
	}

	if (pick.toggleVariants) {
		await configService.setShowEffortVariants(!variantsShown);
		return;
	}

	if (pick.openMaxTokens) {
		await vscode.commands.executeCommand("workbench.action.openSettings", MAX_OUTPUT_TOKENS_SETTING);
		return;
	}

	if (pick.value === "off") {
		await configService.setThinkingDefault(false);
		return;
	}

	if (!pick.value) {
		return;
	}

	// Refuse a level known not to work, and say what to do instead, rather than
	// writing a setting that will fail on the next request.
	if (pick.availability?.fit === "impossible") {
		const openSetting = "Open Setting";
		const choice = await vscode.window.showWarningMessage(
			detailForAvailability(pick.availability) ?? "That effort level cannot be used with the current limits.",
			...(pick.availability.limitedBySetting ? [openSetting] : [])
		);
		if (choice === openSetting) {
			await vscode.commands.executeCommand("workbench.action.openSettings", MAX_OUTPUT_TOKENS_SETTING);
		}
		return;
	}

	await configService.setThinkingDefault(true, pick.value);
}
