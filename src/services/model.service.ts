import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { BedrockModelSummary, AuthConfig, ManualModel } from "../types";
import { BedrockClient } from "../clients/bedrock.client";
import { OpenRouterClient } from "./openrouter.client";
import { AuthenticationService } from "./authentication.service";
import { ConfigurationService } from "./configuration.service";
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
 * Convert a user-declared ManualModel into the BedrockModelSummary shape the
 * rest of the pipeline expects. Manual models are assumed streaming + TEXT so
 * they survive the capability filter; vision is opt-in.
 */
export function manualModelToSummary(mm: ManualModel): BedrockModelSummary {
	return {
		modelArn: "",
		modelId: mm.id,
		modelName: mm.name ?? mm.id,
		providerName: mm.id.split(".")[0] || "Bedrock",
		inputModalities: mm.vision ? ["TEXT", "IMAGE"] : ["TEXT"],
		outputModalities: ["TEXT"],
		responseStreamingSupported: true,
		customizationsSupported: [],
		inferenceTypesSupported: ["INFERENCE_PROFILE"],
		modelLifecycle: { status: "ACTIVE" },
	};
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

		const manualModels = this.configService.getManualModels();

		try {
			const credentials = this.authService.getCredentials(authConfig);
			[models, availableProfileIds] = await Promise.all([
				this.bedrockClient.fetchModels(credentials),
				this.bedrockClient.fetchInferenceProfiles(credentials),
			]);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Model Service] Failed to fetch models", err);
			// If the user has declared models manually, prefer degrading to those
			// over failing outright — this keeps the extension usable where model
			// listing is blocked (e.g. an SCP deny) but invocation is allowed.
			if (manualModels.length === 0) {
				if (!silent) {
					vscode.window.showErrorMessage(`Failed to fetch Bedrock models: ${errorMsg}`);
				}
				return [];
			}
			logger.log(
				`[Model Service] Model listing unavailable; falling back to ${manualModels.length} manually configured model(s).`
			);
			models = [];
			availableProfileIds = new Set<string>();
		}

		// Merge manually-declared models with anything discovered. Manual entries
		// fill gaps (by bare model ID) without clobbering discovered metadata.
		const manualById = new Map(manualModels.map((mm) => [mm.id, mm]));
		if (manualModels.length > 0) {
			const discovered = new Set(models.map((m) => m.modelId));
			for (const mm of manualModels) {
				if (!discovered.has(mm.id)) {
					models.push(manualModelToSummary(mm));
				}
			}
		}

		const infos: LanguageModelChatInformation[] = [];
		// A manual model's inferenceProfile acts like an implicit override, so
		// routing works even when ListInferenceProfiles returned nothing. Explicit
		// user overrides still win.
		const overrides: Record<string, string> = { ...this.configService.getInferenceProfileOverrides() };
		for (const mm of manualModels) {
			if (mm.inferenceProfile && !(mm.id in overrides)) {
				overrides[mm.id] = mm.inferenceProfile;
			}
		}
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

			// Try to get model properties from OpenRouter, fall back to defaults.
			// An explicit manual override takes precedence over both (useful when
			// OpenRouter is unreachable in a locked-down network).
			const manual = manualById.get(m.modelId);
			const properties = await this.openRouterClient.getModelProperties(m.modelId);
			const maxInput = manual?.maxInputTokens ?? properties?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = manual?.maxOutputTokens ?? properties?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
			const vision = m.inputModalities.includes("IMAGE");

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
