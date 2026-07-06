import * as vscode from "vscode";
import type { AuthMethod } from "../types";

/**
 * Centralized configuration management for Bedrock extension.
 * All VS Code settings access should go through this service.
 */
export class ConfigurationService {
	private readonly configSection = 'languageModelChatProvider.bedrock';

	/**
	 * Get the AWS region from configuration
	 */
	getRegion(): string {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('region') ?? "us-east-1";
	}

	/**
	 * Get the authentication method from configuration
	 */
	getAuthMethod(): AuthMethod {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<AuthMethod>('authMethod') ?? 'default';
	}

	/**
	 * Get API key from configuration (if using api-key auth)
	 */
	getApiKey(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('apiKey');
	}

	/**
	 * Get AWS profile name from configuration (if using profile auth)
	 */
	getProfile(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('profile');
	}

	/**
	 * Get AWS access key ID from configuration (if using access-keys auth)
	 */
	getAccessKeyId(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('accessKeyId');
	}

	/**
	 * Get AWS secret access key from configuration (if using access-keys auth)
	 */
	getSecretAccessKey(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('secretAccessKey');
	}

	/**
	 * Get AWS session token from configuration (if using access-keys auth with temp credentials)
	 */
	getSessionToken(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('sessionToken');
	}

	/**
	 * Whether extended thinking / reasoning is enabled.
	 * Only applied to models whose profile reports supportsThinking.
	 */
	getThinkingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<boolean>('thinking.enabled') ?? true;
	}

	/**
	 * Reasoning effort level. Maps to a thinking token budget.
	 */
	getEffort(): 'max' | 'high' | 'medium' | 'low' {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<'max' | 'high' | 'medium' | 'low'>('effort') ?? 'max';
	}

	/**
	 * Explicit thinking budget token override. When set (> 0), it takes
	 * precedence over the effort-derived budget. null/0 means "derive from effort".
	 */
	getThinkingBudgetTokens(): number | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const value = config.get<number | null>('thinking.budgetTokens');
		return typeof value === 'number' && value > 0 ? value : undefined;
	}

	/**
	 * Get user-provided inference profile overrides.
	 * Maps bare model IDs (e.g. "anthropic.claude-sonnet-4-6") to
	 * full inference profile ARNs or IDs to use at invocation time.
	 */
	getInferenceProfileOverrides(): Record<string, string> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<Record<string, string>>('inferenceProfileOverrides') ?? {};
	}
}
