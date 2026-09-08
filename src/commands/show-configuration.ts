import * as vscode from "vscode";
import { logger } from "../logger";
import type { AuthMethod } from "../types";
import type { ThinkingEffort } from "../converters/request";
import { resolveMaxTokens } from "../converters/request";
import type { CeilingSource } from "../services/model.service";
import { getModelProfile } from "../profiles";

export const SHOW_CONFIGURATION_COMMAND = "bedrock.showConfiguration";

/** One model's discovered limits, as the report needs them. */
export interface ModelDiagnostic {
	modelId: string;
	maxInputTokens?: number;
	maxOutputTokens: number;
	ceilingSource: CeilingSource;
	/** The built-in table value, when something else was preferred over it. */
	tableValue?: number;
	/** Invocation target actually sent to Bedrock, when it differs from the ID. */
	invocationTarget?: string;
}

/** Everything the report describes. Gathered by the caller, so this stays pure. */
export interface ConfigurationSnapshot {
	extensionVersion?: string;
	region: string;
	authMethod: AuthMethod;
	/** Whether the configured auth method actually resolved to credentials. */
	authResolved: boolean;
	/** Non-secret detail, e.g. the profile name. Never a key or token. */
	authDetail?: string;
	thinking: {
		enabled: boolean;
		effort: ThinkingEffort;
		budgetTokens?: number;
		display: string;
		showEffortVariants: boolean;
	};
	maxOutputTokens?: number;
	promptCaching: boolean;
	nativeTokenCounting: boolean;
	manualModelCount: number;
	inferenceProfileOverrideCount: number;
	models: ModelDiagnostic[];
	/** True when model discovery has not run yet. */
	discoveryPending: boolean;
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Render a paste-ready diagnostic report.
 *
 * Exists because the settings that matter most interact: an output-token cap, a
 * reasoning effort and a per-model ceiling together decide whether a request is
 * even valid, and none of them is visible in one place. Diagnosing the
 * `maxTokens: 1` regression required reading three separate log sections and
 * knowing that `0` was a sentinel. This prints the resolved values, not the raw
 * settings, so a bug report shows what the extension actually did.
 *
 * Pure and secret-free by construction: the snapshot it formats carries no keys
 * or tokens, so the output is always safe to paste into an issue.
 */
export function formatConfigurationReport(s: ConfigurationSnapshot): string {
	const lines: string[] = [];
	const push = (text = "") => lines.push(text);

	push("# AWS Bedrock Chat — effective configuration");
	push();
	push(`Generated ${new Date().toISOString()}`);
	if (s.extensionVersion) {
		push(`Extension version ${s.extensionVersion}`);
	}
	push();
	push("Safe to paste into a bug report: no credentials are included.");
	push();

	push("## Connection");
	push();
	push(`- Region: \`${s.region}\``);
	push(
		`- Auth method: \`${s.authMethod}\`` +
			(s.authDetail ? ` (${s.authDetail})` : "") +
			` — ${s.authResolved ? "resolved" : "**not resolved**"}`
	);
	if (!s.authResolved) {
		push(`  - No usable credentials. Run **Manage AWS Bedrock Provider** to configure authentication.`);
	}
	push();

	push("## Output tokens and reasoning");
	push();
	push(
		`- \`maxOutputTokens\`: ${
			s.maxOutputTokens === undefined
				? "**0** — use each model's own maximum (recommended)"
				: `**${n(s.maxOutputTokens)}** — a hard cap on every response`
		}`
	);
	push(`- Extended thinking: ${s.thinking.enabled ? `**on** at \`${s.thinking.effort}\` effort` : "**off**"}`);
	push(
		`- \`thinking.budgetTokens\`: ${
			s.thinking.budgetTokens === undefined
				? "0 — derived from the effort level"
				: `**${n(s.thinking.budgetTokens)}** (legacy budget API models only)`
		}`
	);
	push(`- Reasoning display: \`${s.thinking.display}\``);
	push(`- Effort variants in the model picker: ${s.thinking.showEffortVariants ? "on" : "off"}`);
	push(`- Prompt caching: ${s.promptCaching ? "on" : "off"}`);
	push(`- Bedrock token counting: ${s.nativeTokenCounting ? "on" : "off"}`);
	push();

	push("## Models");
	push();
	if (s.discoveryPending) {
		push("Model discovery has not run yet. Open the chat model picker once, then re-run this command.");
		push();
	} else if (s.models.length === 0) {
		push("No models were discovered. Check the region and authentication above.");
		push();
	} else {
		push(
			`${s.models.length} model(s). **Effective max tokens** is what a request would actually send, ` +
				"including any increase needed to fit the reasoning budget."
		);
		push();
		push("| Model | Context | Model ceiling | Ceiling source | Effective max tokens | Reasoning |");
		push("|---|---|---|---|---|---|");
		for (const m of s.models) {
			push(`| ${describeModelRow(m, s)} |`);
		}
		push();

		const fallbacks = s.models.filter((m) => m.ceilingSource === "table");
		if (fallbacks.length > 0) {
			push(
				`> **${fallbacks.length} model(s) fell back to built-in ceiling defaults** because no provider figure ` +
					"was available. Those defaults are deliberately conservative and may be lower than the model " +
					"allows, which shortens long responses. Set `maxOutputTokens` per model via `manualModels` " +
					"to override."
			);
			push();
		}

		const blocked = s.models.filter((m) => resolveFor(m, s).conflict !== undefined);
		if (blocked.length > 0) {
			push(
				`> **${blocked.length} model(s) cannot currently run with reasoning enabled**: \`maxOutputTokens\` ` +
					`is set to ${n(s.maxOutputTokens ?? 0)}, which is too small for \`${s.thinking.effort}\` effort. ` +
					"Set it to `0`, or lower the effort."
			);
			push();
		}
	}

	push("## Overrides");
	push();
	push(`- Manually declared models: ${s.manualModelCount}`);
	push(`- Inference profile overrides: ${s.inferenceProfileOverrideCount}`);
	push();

	return lines.join("\n");
}

/** Resolve what a request against this model would actually send. */
function resolveFor(m: ModelDiagnostic, s: ConfigurationSnapshot) {
	const api = getModelProfile(m.modelId).thinkingApi;
	return resolveMaxTokens({
		modelCeiling: m.maxOutputTokens,
		settingMaxTokens: s.maxOutputTokens,
		thinking:
			s.thinking.enabled && api !== "none"
				? { api, effort: s.thinking.effort, budgetTokens: s.thinking.budgetTokens }
				: undefined,
	});
}

function describeModelRow(m: ModelDiagnostic, s: ConfigurationSnapshot): string {
	const api = getModelProfile(m.modelId).thinkingApi;
	const r = resolveFor(m, s);

	const ceilingSource =
		m.ceilingSource === "table"
			? "built-in default"
			: m.ceilingSource === "openrouter"
				? m.tableValue !== undefined && m.maxOutputTokens > m.tableValue
					? `provider (default was ${n(m.tableValue)})`
					: "provider"
				: "manual override";

	let effective = n(r.maxTokens);
	if (r.conflict) {
		effective = `${n(r.maxTokens)} — **too small for reasoning**`;
	} else if (r.source === "setting") {
		effective = `${n(r.maxTokens)} — capped by settings`;
	}

	// Describe the API the model uses, not whichever field happened to be
	// populated: a budget-API model whose budget did not fit resolves to no
	// budget at all, and labelling that "adaptive" would be simply wrong.
	const reasoning =
		api === "none"
			? "not supported"
			: !s.thinking.enabled
				? "off"
				: r.conflict
					? "**blocked**"
					: api === "budget"
						? `${n(r.budgetTokens ?? 0)}-token budget`
						: r.effortDowngradedFrom
							? `adaptive, \`${r.effort}\` _(reduced from \`${r.effortDowngradedFrom}\`)_`
							: `adaptive, \`${r.effort ?? s.thinking.effort}\``;

	const name = m.invocationTarget ? `\`${m.modelId}\`<br>→ \`${m.invocationTarget}\`` : `\`${m.modelId}\``;

	return [
		name,
		m.maxInputTokens !== undefined ? n(m.maxInputTokens) : "?",
		n(m.maxOutputTokens),
		ceilingSource,
		effective,
		reasoning,
	].join(" | ");
}

/**
 * Gather the snapshot and open it as a Markdown document.
 *
 * A new untitled document rather than the output channel: the report is meant to
 * be selected and pasted whole, which an append-only channel interleaved with
 * request logs makes needlessly awkward.
 */
export async function showConfiguration(deps: {
	configService: {
		getRegion(): string;
		getAuthMethod(): AuthMethod;
		getProfile(): string | undefined;
		isThinkingEnabled(): boolean;
		getThinkingEffort(): ThinkingEffort;
		getThinkingBudgetTokens(): number | undefined;
		getThinkingDisplay(): string;
		showEffortVariants(): boolean;
		getMaxOutputTokens(): number | undefined;
		isPromptCachingEnabled(): boolean;
		isNativeTokenCountingEnabled(): boolean;
		getManualModels(): unknown[];
		getInferenceProfileOverrides(): Record<string, string>;
	};
	authService: { getAuthConfig(silent?: boolean): Promise<unknown> };
	models: {
		getCeilings(): ReadonlyMap<string, { maxOutputTokens: number; source: CeilingSource; tableValue?: number }>;
		getInputCeiling(modelId: string): number | undefined;
		getInvocationTarget(modelId: string): string | undefined;
	};
	extensionVersion?: string;
}): Promise<void> {
	const { configService, authService, models } = deps;

	// Silent, because this command is diagnostic: it must report that auth is
	// unresolved rather than pop the configuration prompts as a side effect.
	let authResolved = false;
	try {
		authResolved = Boolean(await authService.getAuthConfig(true));
	} catch (err) {
		logger.warn("[Show Configuration] Could not resolve authentication", err);
	}

	const ceilings = models.getCeilings();
	const authMethod = configService.getAuthMethod();

	const snapshot: ConfigurationSnapshot = {
		extensionVersion: deps.extensionVersion,
		region: configService.getRegion(),
		authMethod,
		authResolved,
		// Only ever a non-secret hint. Keys, tokens and secrets are never read here.
		authDetail: authMethod === "profile" ? configService.getProfile() : undefined,
		thinking: {
			enabled: configService.isThinkingEnabled(),
			effort: configService.getThinkingEffort(),
			budgetTokens: configService.getThinkingBudgetTokens(),
			display: configService.getThinkingDisplay(),
			showEffortVariants: configService.showEffortVariants(),
		},
		maxOutputTokens: configService.getMaxOutputTokens(),
		promptCaching: configService.isPromptCachingEnabled(),
		nativeTokenCounting: configService.isNativeTokenCountingEnabled(),
		manualModelCount: configService.getManualModels().length,
		inferenceProfileOverrideCount: Object.keys(configService.getInferenceProfileOverrides()).length,
		discoveryPending: ceilings.size === 0,
		models: [...ceilings.entries()]
			.map(([modelId, ceiling]) => ({
				modelId,
				maxInputTokens: models.getInputCeiling(modelId),
				maxOutputTokens: ceiling.maxOutputTokens,
				ceilingSource: ceiling.source,
				tableValue: ceiling.tableValue,
				invocationTarget: models.getInvocationTarget(modelId),
			}))
			.sort((a, b) => a.modelId.localeCompare(b.modelId)),
	};

	const report = formatConfigurationReport(snapshot);
	logger.log("[Show Configuration] Effective configuration report generated");

	const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
	await vscode.window.showTextDocument(doc, { preview: false });
}
