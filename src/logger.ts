import * as vscode from "vscode";

/**
 * Logger that outputs to a dedicated Output Channel.
 * Users can view logs via View > Output > Bedrock Chat
 */
class Logger {
	private outputChannel: vscode.OutputChannel | null = null;
	private extensionMode: vscode.ExtensionMode = vscode.ExtensionMode.Production;

	initialize(outputChannel: vscode.OutputChannel, mode: vscode.ExtensionMode): void {
		this.outputChannel = outputChannel;
		this.extensionMode = mode;
	}

	private formatMessage(level: string, args: any[]): string {
		const timestamp = new Date().toISOString();
		const message = args.map(arg => this.safeStringify(arg)).join(' ');
		return `[${timestamp}] [${level}] ${message}`;
	}

	/**
	 * Safely stringify objects, handling circular references and errors.
	 */
	private safeStringify(value: any): string {
		if (value === null || value === undefined) {
			return String(value);
		}

		if (typeof value !== 'object') {
			return String(value);
		}

		// Handle Error objects specially to extract useful information
		if (value instanceof Error) {
			const errorInfo: any = {
				name: value.name,
				message: value.message,
			};

			// Include stack trace if available
			if (value.stack) {
				errorInfo.stack = value.stack;
			}

			// Include any additional properties on the error
			for (const key of Object.keys(value)) {
				if (key !== 'name' && key !== 'message' && key !== 'stack') {
					try {
						errorInfo[key] = value[key as keyof Error];
					} catch {
						// Skip properties that can't be accessed
					}
				}
			}

			try {
				return JSON.stringify(errorInfo, null, 2);
			} catch {
				return `${value.name}: ${value.message}`;
			}
		}

		// Handle circular references with a replacer function
		const seen = new WeakSet();
		try {
			return JSON.stringify(value, (key, val) => {
				if (typeof val === 'object' && val !== null) {
					if (seen.has(val)) {
						return '[Circular Reference]';
					}
					seen.add(val);
				}
				return val;
			}, 2);
		} catch (err) {
			// Fallback: use Object.prototype.toString if JSON.stringify fails
			return Object.prototype.toString.call(value);
		}
	}

	private logToChannel(level: string, args: any[]): void {
		if (this.outputChannel) {
			const message = this.formatMessage(level, args);
			this.outputChannel.appendLine(message);
		}
	}

	private logToConsole(method: 'log' | 'error' | 'warn' | 'info' | 'debug', args: any[]): void {
		if (this.extensionMode === vscode.ExtensionMode.Development ||
		    this.extensionMode === vscode.ExtensionMode.Test) {
			console[method](...args);
		}
	}

	log(...args: any[]): void {
		this.logToChannel('INFO', args);
		this.logToConsole('log', args);
	}

	error(...args: any[]): void {
		this.logToChannel('ERROR', args);
		this.logToConsole('error', args);
	}

	warn(...args: any[]): void {
		this.logToChannel('WARN', args);
		this.logToConsole('warn', args);
	}

	info(...args: any[]): void {
		this.logToChannel('INFO', args);
		this.logToConsole('info', args);
	}

	debug(...args: any[]): void {
		this.logToChannel('DEBUG', args);
		this.logToConsole('debug', args);
	}
}

export const logger = new Logger();
