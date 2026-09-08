// STAGE (regression guard): the DEFAULT install state — extended thinking on, `maxOutputTokens`
// left at its `0` default — must produce a valid request.
//
// This is the combination that broke in the field. `maxOutputTokens` defaults to `0`, documented
// as "use the model's maximum", but the request builder selected it with `?? modelCeiling`, and
// `??` does not treat `0` as absent. The sentinel won the precedence chain, every request went
// out with `maxTokens: 1`, and enabling thinking then failed outright because no reasoning budget
// can fit below Anthropic's 1024-token floor:
//
//   `max_tokens` must be greater than `thinking.budget_tokens`
//
// The offline sweep in scripts/live-feature-test.js proves the arithmetic. This stage proves the
// wire: that the settings a real user actually has produce a request Bedrock accepts. It asserts
// on the log's own resolution line rather than on reply text alone, because a truncated response
// and a healthy one can look similar from the outside — `maxTokens: 1` would still "reply", just
// with a single token.

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotBedrockChatLog, bedrockChatLogDelta } from '../lib/verify.mjs';
import { sleep } from '../lib/config.mjs';

export const TOKEN = 'THINKING_DEFAULTS_OK';

/** Minimum output limit that proves the `0` sentinel was not taken literally. */
const SANE_MIN_MAX_TOKENS = 1024;

/**
 * Merge keys into the running instance's settings.json.
 *
 * Written to disk rather than driven through the settings UI: the UI path is slow and its
 * selectors are the most brittle part of this harness, and VS Code applies external edits to
 * settings.json immediately, which is exactly the "user changed a setting" event under test.
 */
function patchSettings(userDataDir, patch) {
  const file = join(userDataDir, 'User', 'settings.json');
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const merged = { ...current, ...patch };
  writeFileSync(file, JSON.stringify(merged, null, 2));
  return current;
}

export async function run(ctx) {
  const { ui, userDataDir } = ctx;
  console.log('[harness] STAGE 08: default-state thinking (maxOutputTokens unset + thinking on)');

  // Explicitly assert the `0` default rather than merely omitting the key: omission and `0` took
  // different paths through the old code, and `0` is the one that was broken.
  const previous = patchSettings(userDataDir, {
    'languageModelChatProvider.bedrock.maxOutputTokens': 0,
    'languageModelChatProvider.bedrock.thinking.enabled': true,
    'languageModelChatProvider.bedrock.thinking.effort': 'high',
    'languageModelChatProvider.bedrock.thinking.budgetTokens': 0,
  });

  // Let the configuration-change listener run before the request is sent.
  await sleep(1500);

  const logSnapshot = snapshotBedrockChatLog(userDataDir);
  await ui.typePrompt(`Think briefly, then reply with exactly this token and nothing else: ${TOKEN}`);
  const r = await ui.waitResponse({ maxMs: 60000 });
  await ui.shot('thinking-defaults');

  const delta = bedrockChatLogDelta(userDataDir, logSnapshot);

  // Restore, so a stage added after this one sees the profile it expects.
  patchSettings(userDataDir, {
    'languageModelChatProvider.bedrock.maxOutputTokens':
      previous['languageModelChatProvider.bedrock.maxOutputTokens'] ?? 0,
    'languageModelChatProvider.bedrock.thinking.enabled':
      previous['languageModelChatProvider.bedrock.thinking.enabled'] ?? false,
  });

  ctx.results.thinkingDefaults = { replyText: r.text, delta, logSnapshot };
  console.log('[harness] THINKING DEFAULTS RESULT | ' + JSON.stringify(r.text.slice(0, 200)));
}

/**
 * Classify the stage from its own log delta.
 *
 * SKIP is reserved for "this could not be exercised here" — an auth or model-access deny that
 * short-circuits before the request body is built. Anything else is a real verdict, because the
 * whole point is that this configuration must not fail.
 */
export function classify({ replyText, delta, token }) {
  if (/is not authorized|AccessDenied|don't have access|Invalid API Key/i.test(delta)) {
    return { verdict: 'skip', reason: 'auth or model-access deny short-circuited the request' };
  }

  // The exact production failure.
  if (/max_tokens.{0,40}greater than.{0,40}budget_tokens/i.test(delta)) {
    return { verdict: 'fail', reason: 'Bedrock rejected the max_tokens/thinking.budget_tokens pair' };
  }

  const resolved = /Resolved output-token limit[\s\S]{0,400}?"maxTokens":\s*(\d+)/.exec(delta);
  if (!resolved) {
    return { verdict: 'fail', reason: 'no "Resolved output-token limit" line in the log delta' };
  }
  const maxTokens = Number(resolved[1]);
  if (maxTokens < SANE_MIN_MAX_TOKENS) {
    return {
      verdict: 'fail',
      reason: `maxTokens resolved to ${maxTokens} — the 0 sentinel was taken literally again`,
    };
  }

  const streamed = /Finished processing stream/.test(delta);
  if (!streamed) {
    return { verdict: 'fail', reason: `stream did not complete (maxTokens=${maxTokens})` };
  }

  // Thinking must actually have been requested, or this stage proves nothing about the pairing.
  const thinkingOn = /"thinking":\s*true/.test(delta);
  if (!thinkingOn) {
    return { verdict: 'fail', reason: `thinking was not enabled on the request (maxTokens=${maxTokens})` };
  }

  if (!new RegExp(token).test(replyText || '')) {
    return { verdict: 'fail', reason: `reply did not contain ${token} (maxTokens=${maxTokens})` };
  }

  return { verdict: 'pass', reason: `maxTokens=${maxTokens}, thinking on, stream completed` };
}
