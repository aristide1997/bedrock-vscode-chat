import * as vscode from "vscode";
import { ConfigurationService } from "./services/configuration.service";
import { SELECT_THINKING_EFFORT_COMMAND } from "./commands/select-thinking-effort";
import { assessEffort, type EffortAvailability } from "./effort-availability";
import { getModelProfile } from "./profiles";

/**
 * What the status bar needs in order to say whether the current effort is
 * actually usable. Supplied by the extension host after model discovery; absent
 * until then, in which case the item still shows the effort, just without limits.
 */
export interface StatusBarModelContext {
	modelId: string;
	ceiling: number;
}

/**
 * Status bar item showing, and letting you change, the global reasoning-effort
 * default.
 *
 * Deliberately not gated behind a setting of its own. VS Code already lets a
 * user hide any status bar item from its right-click menu, and an item with an
 * `id` and a `name` has that choice remembered — a bespoke
 * `showStatusBarItem` setting would only duplicate a native affordance.
 */
export class ThinkingStatusBar {
	private readonly item: vscode.StatusBarItem;
	private modelContext?: StatusBarModelContext;

	constructor(private readonly configService: ConfigurationService) {
		this.item = vscode.window.createStatusBarItem(
			"bedrock.thinkingEffort",
			vscode.StatusBarAlignment.Right,
			100
		);
		this.item.name = "Bedrock Thinking Effort";
		this.item.command = SELECT_THINKING_EFFORT_COMMAND;
		this.refresh();
		this.item.show();
	}

	/**
	 * Supply the model whose limits the item should reason about. Called once
	 * discovery has run, since the ceiling is not knowable before then.
	 */
	setModelContext(context: StatusBarModelContext | undefined): void {
		this.modelContext = context;
		this.refresh();
	}

	/** Re-read the settings this item reflects. Called on configuration change. */
	refresh(): void {
		const enabled = this.configService.isThinkingEnabled();
		const effort = this.configService.getThinkingEffort();
		const settingMaxTokens = this.configService.getMaxOutputTokens();
		const budgetTokens = this.configService.getThinkingBudgetTokens();

		const availability =
			enabled && this.modelContext
				? assessEffort({
						effort,
						ceiling: this.modelContext.ceiling,
						settingMaxTokens,
						budgetTokens,
						api: getModelProfile(this.modelContext.modelId).thinkingApi === "budget" ? "budget" : "adaptive",
					})
				: undefined;

		// A conflict has to be visible without hovering: a setting that silently
		// will not work on the next request is exactly what this whole area got
		// wrong before.
		const glyph =
			availability?.fit === "impossible"
				? "$(error)"
				: availability?.fit === "tight"
					? "$(warning)"
					: enabled
						? "$(lightbulb)"
						: "$(lightbulb-empty)";

		this.item.text = enabled ? `${glyph} Bedrock: think ${effort}` : `${glyph} Bedrock: think off`;
		this.item.backgroundColor =
			availability?.fit === "impossible"
				? new vscode.ThemeColor("statusBarItem.errorBackground")
				: availability?.fit === "tight"
					? new vscode.ThemeColor("statusBarItem.warningBackground")
					: undefined;

		this.item.tooltip = this.buildTooltip(enabled, effort, settingMaxTokens, availability);
	}

	private buildTooltip(
		enabled: boolean,
		effort: string,
		settingMaxTokens: number | undefined,
		availability: EffortAvailability | undefined
	): vscode.MarkdownString {
		const n = (v: number) => v.toLocaleString("en-US");
		const tooltip = new vscode.MarkdownString();

		tooltip.appendMarkdown(
			enabled
				? `Bedrock extended thinking is **on** at **${effort}** effort.\n\n`
				: `Bedrock extended thinking is **off**.\n\n`
		);

		if (availability) {
			tooltip.appendMarkdown(
				`| | |\n|---|---|\n` +
					`| Reasoning budget | ${n(availability.budget)} tokens |\n` +
					`| Output limit | ${n(availability.resolved)} tokens${
						availability.limitedBySetting ? " _(from settings)_" : " _(model maximum)_"
					} |\n` +
					`| Model ceiling | ${n(availability.ceiling)} tokens |\n\n`
			);

			if (availability.fit === "impossible") {
				tooltip.appendMarkdown(
					`$(error) **This combination cannot be used.** This level needs at least ` +
						`${n(availability.required)} output tokens. Requests will fail until the ` +
						`output limit is raised or the effort lowered.\n\n`
				);
			} else if (availability.fit === "tight") {
				tooltip.appendMarkdown(
					`$(warning) **Reasoning will be cut short.** This level wants ${n(availability.required)} ` +
						`output tokens but only ${n(availability.resolved)} are available.\n\n`
				);
			}
		} else if (enabled && settingMaxTokens !== undefined) {
			tooltip.appendMarkdown(`Output limit capped at ${n(settingMaxTokens)} tokens by settings.\n\n`);
		}

		tooltip.appendMarkdown(
			"This is the default for every conversation. A model picked as " +
				"`· think <level>` in the chat window overrides it for that conversation, " +
				"and `· think off` suppresses reasoning for one conversation without " +
				"changing this default.\n\n" +
				"Click to change."
		);
		// Required for $(icon) syntax to render inside a MarkdownString.
		tooltip.supportThemeIcons = true;
		return tooltip;
	}

	dispose(): void {
		this.item.dispose();
	}
}
