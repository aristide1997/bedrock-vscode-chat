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
	 * Check if thinking (extended reasoning) is enabled
	 */
	isThinkingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<boolean>('thinkingEnabled', false);
	}

	/**
	 * Get thinking budget tokens (minimum 1024)
	 */
	getThinkingBudgetTokens(): number {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const budget = config.get<number>('thinkingBudgetTokens', 1024);
		return Math.max(1024, budget);
	}

	/**
	 * Get thinking configuration if enabled
	 */
	getThinkingConfig(): { type: 'enabled' | 'disabled'; budget_tokens?: number } | undefined {
		if (!this.isThinkingEnabled()) {
			return undefined;
		}

		return {
			type: 'enabled',
			budget_tokens: this.getThinkingBudgetTokens(),
		};
	}
}
