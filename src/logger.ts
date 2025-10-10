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
		const message = args.map(arg =>
			typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
		).join(' ');
		return `[${timestamp}] [${level}] ${message}`;
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
