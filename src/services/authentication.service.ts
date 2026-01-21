import * as vscode from "vscode";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AuthConfig } from "../types";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";
import { ConfigurationService } from "./configuration.service";
import { logger } from "../logger";

/**
 * Manages AWS authentication and credential creation.
 * Handles all authentication methods: default, api-key, profile, and access-keys.
 */
export class AuthenticationService {
	constructor(private readonly configService: ConfigurationService) {}

	/**
	 * Get authentication configuration from VS Code settings
	 */
	async getAuthConfig(silent: boolean = false): Promise<AuthConfig | undefined> {
		const method = this.configService.getAuthMethod();

		if (method === 'default') {
			return { method: 'default' };
		}

		if (method === 'api-key') {
			const apiKey = this.configService.getApiKey();
			if (!apiKey && !silent) {
				vscode.window.showInformationMessage(
					'Please configure your AWS Bedrock API Key in settings or run "Configure AWS Bedrock".'
				);
				return undefined;
			}
			if (!apiKey) {
				return undefined;
			}
			return { method: 'api-key', apiKey };
		}

		if (method === 'profile') {
			const profile = this.configService.getProfile();
			if (!profile && !silent) {
				vscode.window.showInformationMessage(
					'Please configure your AWS profile in settings or run "Configure AWS Bedrock".'
				);
				return undefined;
			}
			if (!profile) {
				return undefined;
			}
			return { method: 'profile', profile };
		}

		if (method === 'access-keys') {
			const accessKeyId = this.configService.getAccessKeyId();
			const secretAccessKey = this.configService.getSecretAccessKey();
			const sessionToken = this.configService.getSessionToken();

			if (!accessKeyId || !secretAccessKey) {
				if (!silent) {
					vscode.window.showInformationMessage(
						'Please configure your AWS access keys in settings or run "Configure AWS Bedrock".'
					);
				}
				return undefined;
			}

			return {
				method: 'access-keys',
				accessKeyId,
				secretAccessKey,
				...(sessionToken && { sessionToken }),
			};
		}

		return undefined;
	}

	/**
	 * Create AWS credentials from authentication configuration
	 */
	getCredentials(authConfig: AuthConfig): AwsCredentialIdentity | Provider<AwsCredentialIdentity> | undefined {
		// Clean up API key environment variable if not using API key auth
		if (authConfig.method !== 'api-key') {
			delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		}

		if (authConfig.method === 'api-key') {
			if (!authConfig.apiKey) {
				throw new Error('API key is required for api-key authentication method');
			}
			process.env.AWS_BEARER_TOKEN_BEDROCK = authConfig.apiKey;
			logger.log("[Authentication Service] Using API key authentication");
			return undefined;
		}

		if (authConfig.method === 'profile') {
			if (!authConfig.profile) {
				throw new Error('Profile name is required for profile authentication method');
			}
			logger.log("[Authentication Service] Using profile authentication:", authConfig.profile);
			return fromIni({ profile: authConfig.profile });
		}

		if (authConfig.method === 'access-keys') {
			if (!authConfig.accessKeyId || !authConfig.secretAccessKey) {
				throw new Error('Access key ID and secret access key are required for access-keys authentication method');
			}
			logger.log("[Authentication Service] Using access keys authentication");
			return {
				accessKeyId: authConfig.accessKeyId,
				secretAccessKey: authConfig.secretAccessKey,
				...(authConfig.sessionToken && { sessionToken: authConfig.sessionToken }),
			};
		}

		// 'default' method - use AWS SDK's default credential provider chain
		logger.log("[Authentication Service] Using default credential provider chain");
		return undefined;
	}
}
