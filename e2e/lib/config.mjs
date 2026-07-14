// Shared constants + env resolution for the E2E harness. Pure values only (no I/O), so
// every module reads the same configuration. See e2e/README.md for the env-var contract.

import { resolve, join } from 'node:path';

export const E2E_DIR = resolve(import.meta.dirname, '..');
export const REPO = resolve(E2E_DIR, '..');
export const SHOTS = join(E2E_DIR, 'shots');
export const ASSETS = join(E2E_DIR, 'assets');

export const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9222);
export const REGION = process.env.E2E_REGION || 'eu-central-1';
export const TARGET_MODEL = process.env.E2E_MODEL || 'Claude Haiku 4.5';
// The Claude 4+ model whose temperature must be suppressed (regression guard for #21).
export const TEMP_MODEL = process.env.E2E_TEMP_MODEL || 'Claude Sonnet 5';
export const VSCODE_VERSION = process.env.E2E_VSCODE_VERSION || '1.122.1'; // pinned for stable chat-UI selectors
export const VSIX_OVERRIDE = process.env.E2E_VSIX || null; // null → build a fresh VSIX from source
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'; // cross-platform command modifier

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
