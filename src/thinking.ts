import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * How reasoning text should be surfaced to the user.
 * - `hidden`: capture it for replay but show nothing.
 * - `native`: use VS Code's thinking part when the API is present, otherwise nothing.
 * - `text`: always render it, inside a collapsed markdown block.
 */
export type ThinkingDisplay = "hidden" | "native" | "text";

type ThinkingPartCtor = new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;

let cachedCtor: ThinkingPartCtor | null | undefined;

/**
 * Look up `LanguageModelThinkingPart` at runtime.
 *
 * Deliberately not declared via `enabledApiProposals`: this extension shipped
 * that proposal once and the Marketplace rejected the release, so the manifest
 * has to stay on stable API only. Feature-detecting means a user on VS Code
 * Insiders gets first-class thinking rendering while a Marketplace build still
 * installs and runs.
 */
export function getThinkingPartCtor(): ThinkingPartCtor | null {
	if (cachedCtor === undefined) {
		const candidate = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
		cachedCtor = typeof candidate === "function" ? (candidate as ThinkingPartCtor) : null;
		logger.log("[Thinking] Native thinking part available:", cachedCtor !== null);
	}
	return cachedCtor;
}

/** Test seam: forget the cached capability probe. */
export function resetThinkingPartCache(): void {
	cachedCtor = undefined;
}

export interface ThinkingReporter {
	delta(text: string): void;
	end(): void;
}

const DETAILS_OPEN = "\n<details>\n<summary>Reasoning</summary>\n\n";
const DETAILS_CLOSE = "\n\n</details>\n\n";

/**
 * Build a reporter that streams reasoning text for one response.
 *
 * Stateful, so one per stream: the markdown fallback has to remember whether it
 * already opened its `<details>` wrapper.
 */
export function createThinkingReporter(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	display: ThinkingDisplay
): ThinkingReporter {
	if (display === "hidden") {
		return { delta: () => {}, end: () => {} };
	}

	const Ctor = display === "native" ? getThinkingPartCtor() : null;

	if (Ctor) {
		return {
			delta: (text) => {
				try {
					progress.report(new Ctor(text));
				} catch (e) {
					logger.warn("[Thinking] Failed to report thinking part", e);
				}
			},
			end: () => {},
		};
	}

	// `native` on stable VS Code has nowhere to render reasoning, so stay quiet
	// rather than dumping it into the answer the user asked for.
	if (display === "native") {
		return { delta: () => {}, end: () => {} };
	}

	let opened = false;
	return {
		delta: (text) => {
			if (!opened) {
				opened = true;
				progress.report(new vscode.LanguageModelTextPart(DETAILS_OPEN));
			}
			progress.report(new vscode.LanguageModelTextPart(text));
		},
		end: () => {
			if (opened) {
				opened = false;
				progress.report(new vscode.LanguageModelTextPart(DETAILS_CLOSE));
			}
		},
	};
}
