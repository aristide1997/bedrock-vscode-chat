import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { BedrockModelSummary, AuthConfig } from "../types";
import { BedrockClient } from "../clients/bedrock.client";
import { OpenRouterClient } from "./openrouter.client";
import { AuthenticationService } from "./authentication.service";
import { ConfigurationService } from "./configuration.service";
import { getModelProfile } from "../profiles";
import { logger } from "../logger";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_CONTEXT_LENGTH = 200000;

/**
 * The broad geographic inference-profile prefix for a source region
 * (`us.`, `eu.`, `apac.`). AWS groups every ap-* region under the `apac.` geo.
 */
export function regionGeoPrefix(region: string): string {
	return region.startsWith("ap-") ? "apac." : `${region.split("-")[0]}.`;
}

/**
 * Resolve the target to invoke for a bare model ID.
 * Order: user override → the region's own geo pool → any other in-region pool →
 * the worldwide `global.` pool → bare ID (undefined).
 *
 * Preferring any in-region pool over `global.` keeps single-country data-residency
 * pools (e.g. Australia's `au.`, Japan's `jp.`) from being silently widened to all
 * commercial Regions — without hard-coding which countries those happen to be.
 * availableProfileIds is already scoped by AWS to profiles callable from this region.
 *
 * Pure (no I/O) so the routing table is unit-testable without a live Bedrock call.
 */
export function resolveInvocationTarget(
	modelId: string,
	availableProfileIds: Set<string>,
	region: string,
	overrides: Record<string, string>
): string | undefined {
	const override = overrides[modelId];
	if (override) {
		return override;
	}
	const candidates = [...availableProfileIds].filter((pid) => pid.endsWith(`.${modelId}`));
	const geo = regionGeoPrefix(region);
	return (
		candidates.find((pid) => pid.startsWith(geo)) ??
		candidates.find((pid) => !pid.startsWith("global.")) ??
		candidates.find((pid) => pid.startsWith("global.")) ??
		candidates[0]
	);
}

/**
 * Manages model information, capabilities, and metadata.
 * Coordinates between AWS Bedrock and OpenRouter data sources.
 */
export class ModelService {
	private bedrockClient: BedrockClient;
	private openRouterClient: OpenRouterClient;
	private chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];
	/**
	 * Maps a bare model ID to the actual target to use at invocation time.
	 * This is either a user-provided override ARN or a system inference profile ID.
	 * The public model ID stays bare so capability detection (getModelProfile) still works.
	 */
	private invocationTargets = new Map<string, string>();

	constructor(
		private readonly authService: AuthenticationService,
		private readonly configService: ConfigurationService
	) {
		const region = this.configService.getRegion();
		this.bedrockClient = new BedrockClient(region);
		this.openRouterClient = new OpenRouterClient();
	}

	/**
	 * Handle configuration changes (e.g., region updates)
	 */
	handleConfigurationChange(): void {
		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);
		logger.log("[Model Service] Configuration changed, region updated to:", region);
	}

	/**
	 * Fetch and prepare language model chat information
	 */
	async getLanguageModelChatInformation(
		silent: boolean = false
	): Promise<LanguageModelChatInformation[]> {
		const authConfig = await this.authService.getAuthConfig(silent);
		if (!authConfig) {
			return [];
		}

		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);

		let models: BedrockModelSummary[];
		let availableProfileIds: Set<string>;

		try {
			const credentials = this.authService.getCredentials(authConfig);
			[models, availableProfileIds] = await Promise.all([
				this.bedrockClient.fetchModels(credentials),
				this.bedrockClient.fetchInferenceProfiles(credentials),
			]);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Model Service] Failed to fetch models", err);
			if (!silent) {
				vscode.window.showErrorMessage(`Failed to fetch Bedrock models: ${errorMsg}`);
			}
			return [];
		}

		const infos: LanguageModelChatInformation[] = [];
		const overrides = this.configService.getInferenceProfileOverrides();
		this.invocationTargets.clear();

		for (const m of models) {
			if (!m.responseStreamingSupported || !m.outputModalities.includes("TEXT")) {
				continue;
			}

			const invocationTarget = resolveInvocationTarget(m.modelId, availableProfileIds, region, overrides);
			if (invocationTarget) {
				this.invocationTargets.set(m.modelId, invocationTarget);
			}

			const hasInferenceProfile = this.invocationTargets.has(m.modelId);

			// Try to get model properties from OpenRouter, fall back to defaults
			const properties = await this.openRouterClient.getModelProperties(m.modelId);
			const maxInput = properties?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = properties?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
			const vision = m.inputModalities.includes("IMAGE");
			// Capability detection uses the bare model ID: under inference-profile
			// routing the invocation target may be an ARN/profile ID, but the public
			// model ID stays bare so getModelProfile still resolves the profile.
			const profile = getModelProfile(m.modelId);

			const modelInfo: LanguageModelChatInformation = {
				id: m.modelId,
				name: m.modelName,
				tooltip: `AWS Bedrock - ${m.providerName}${hasInferenceProfile ? ' (Cross-Region)' : ''}`,
				detail: `${m.providerName} • ${hasInferenceProfile ? 'Multi-Region' : region}`,
				family: "bedrock",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: {
					toolCalling: true,
					imageInput: vision,
				},
			};

			// Expose a thinking-effort control in the model picker for models that
			// support reasoning. This uses the proposed `configurationSchema` API:
			// a property with `group: "navigation"` renders as a primary action in
			// the picker, and the chosen value is delivered back to the provider via
			// `options.modelConfiguration` on each request.
			if (profile.supportsThinking && profile.reasoningApi !== 'none') {
				const isAdaptive = profile.reasoningApi === 'effort';
				const effortEnum = isAdaptive
					? ['max', 'xhigh', 'high', 'medium', 'low']
					: ['max', 'high', 'medium', 'low'];
				const effortLabels = isAdaptive
					? ['Max', 'Extra High', 'High', 'Medium', 'Low']
					: ['Max', 'High', 'Medium', 'Low'];

				(modelInfo as unknown as { configurationSchema?: unknown }).configurationSchema = {
					properties: {
						effort: {
							type: 'string',
							enum: effortEnum,
							enumItemLabels: effortLabels,
							default: this.configService.getEffort(),
							description: 'Reasoning effort. Higher effort lets the model think longer before answering.',
							group: 'navigation',
						},
						thinkingEnabled: {
							type: 'boolean',
							default: this.configService.getThinkingEnabled(),
							description: 'Enable extended thinking / reasoning for this model.',
						},
					},
				};
			}

			infos.push(modelInfo);
		}

		this.chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		return infos;
	}

	/**
	 * Get cached chat endpoints
	 */
	getChatEndpoints(): { model: string; modelMaxPromptTokens: number }[] {
		return this.chatEndpoints;
	}

	/**
	 * Get the invocation target (override ARN or system profile ID) for a bare model ID.
	 * Returns undefined if the model should be invoked with its bare ID directly.
	 */
	getInvocationTarget(bareModelId: string): string | undefined {
		return this.invocationTargets.get(bareModelId);
	}
}
