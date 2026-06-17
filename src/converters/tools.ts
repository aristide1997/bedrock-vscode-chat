import * as vscode from "vscode";
import type { BedrockToolConfig, BedrockToolSpec } from "../types";
import { sanitizeSchema, sanitizeFunctionName } from "./schema";
import { getModelProfile } from "../profiles";
import { logger } from "../logger";

export function convertTools(
	options: vscode.LanguageModelChatRequestHandleOptions,
	modelId: string,
	thinkingActive = false
): BedrockToolConfig | undefined {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return undefined;
	}

	const profile = getModelProfile(modelId);

	const toolSpecs: BedrockToolSpec[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = sanitizeFunctionName(t.name);
			const description = typeof t.description === "string" ? t.description : "";
			const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
			return {
				name,
				description,
				inputSchema: {
					json: params,
				},
			} satisfies BedrockToolSpec;
		});

	const toolConfig: BedrockToolConfig = {
		tools: toolSpecs.map((spec) => ({ toolSpec: spec })),
	};

	if (profile.supportsToolChoice) {
		// Extended thinking is incompatible with forced tool use: Anthropic only
		// allows tool_choice "auto" (or "none") when thinking is active. Forcing a
		// specific tool returns an error, so we downgrade to "auto" in that case.
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required && !thinkingActive) {
			if (tools.length !== 1) {
				logger.error("[Tool Converter] ToolMode.Required but multiple tools:", tools.length);
				throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
			}
			toolConfig.toolChoice = {
				tool: {
					name: sanitizeFunctionName(tools[0].name),
				},
			};
		} else {
			if (options.toolMode === vscode.LanguageModelChatToolMode.Required && thinkingActive) {
				logger.warn("[Tool Converter] ToolMode.Required ignored because extended thinking is active (Anthropic only allows tool_choice auto with thinking)");
			}
			toolConfig.toolChoice = { auto: {} };
		}
	}

	return toolConfig;
}
