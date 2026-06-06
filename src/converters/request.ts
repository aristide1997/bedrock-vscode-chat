import type { LanguageModelChatInformation, LanguageModelChatRequestHandleOptions } from "vscode";
import { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ModelProfile } from "../profiles";

/**
 * Build the Bedrock ConverseStream request from already-converted pieces.
 *
 * Pure function (no I/O) so the inferenceConfig assembly — temperature omission
 * for models that deprecated it, topP, stopSequences — is unit-testable without
 * a live Bedrock call. Mirrors the request shape the handler previously built inline.
 */
export function buildRequestInput(params: {
	model: Pick<LanguageModelChatInformation, "id" | "maxOutputTokens">;
	converted: { messages: unknown[]; system: unknown[] };
	options: LanguageModelChatRequestHandleOptions;
	profile: ModelProfile;
	toolConfig: unknown;
}): ConverseStreamCommandInput {
	const { model, converted, options, profile, toolConfig } = params;

	const requestInput: ConverseStreamCommandInput = {
		modelId: model.id,
		messages: converted.messages as any,
		inferenceConfig: {
			maxTokens: Math.min(options.modelOptions?.max_tokens || 4096, model.maxOutputTokens),
			// Temperature must be omitted for models that have deprecated it (e.g. Claude 4+)
			...(profile.supportsTemperature && {
				temperature: options.modelOptions?.temperature ?? 0.7,
			}),
		},
	};

	if (converted.system.length > 0) {
		requestInput.system = converted.system as any;
	}

	if (options.modelOptions) {
		const mo = options.modelOptions as Record<string, unknown>;
		if (typeof mo.top_p === "number") {
			requestInput.inferenceConfig!.topP = mo.top_p;
		}
		if (typeof mo.stop === "string") {
			requestInput.inferenceConfig!.stopSequences = [mo.stop];
		} else if (Array.isArray(mo.stop)) {
			requestInput.inferenceConfig!.stopSequences = mo.stop;
		}
	}

	if (toolConfig) {
		requestInput.toolConfig = toolConfig as any;
	}

	return requestInput;
}
