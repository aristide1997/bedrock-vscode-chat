// STAGE (regression guard for #21): Claude Sonnet 5 — and any Claude 4+ — deprecated the
// `temperature` inference parameter; Bedrock rejects a request that still sends it with a
// ValidationException. This stage re-selects Sonnet 5 in the SAME session/region and sends a
// plain prompt. With the fix, getModelProfile suppresses temperature and the request streams;
// without it, the request throws and nothing streams. The proof is behavioral (a real stream
// vs a temperature ValidationException in this stage's own log delta) because the
// inferenceConfig itself isn't logged.
//
// SKIP is reserved for "temperature cannot be exercised here": the model row is genuinely not
// offered in the picker, or (classified later) an auth deny short-circuits before request-body
// validation. A row that exists but could not be selected is a harness failure and throws.

import { TEMP_MODEL } from '../lib/config.mjs';
import { snapshotBedrockChatLog } from '../lib/verify.mjs';

export const TOKEN = 'SONNET5_TEMP_OK';

export async function run(ctx) {
  const { ui, userDataDir } = ctx;
  console.log('[harness] STAGE 07: Claude 5 temperature regression — model:', TEMP_MODEL);

  const { selectedLabel, matched, rowFound } = await ui.pickModel(TEMP_MODEL);
  await ui.shot('sonnet5-selected');

  if (!matched) {
    if (rowFound) {
      throw new Error(`STAGE 07: a Bedrock "${TEMP_MODEL}" row exists in the picker but selecting it failed (active: "${selectedLabel}"). Failing fast instead of skipping the #21 regression guard.`);
    }
    console.log(`[harness] STAGE 07: no Bedrock "${TEMP_MODEL}" row in the picker — SKIPPED. Enable it in the account/region or set E2E_TEMP_MODEL / E2E_REGION.`);
    ctx.results.sonnet5 = { skipped: true, selectedLabel };
    return;
  }

  // Per-file log snapshot so verification inspects only THIS stage's append delta.
  const logSnapshot = snapshotBedrockChatLog(userDataDir);
  await ui.typePrompt(`Reply with exactly this token and nothing else: ${TOKEN}`);
  const r = await ui.waitResponse({ maxMs: 30000 });
  await ui.shot('sonnet5-response');
  ctx.results.sonnet5 = { skipped: false, selectedLabel, replyText: r.text, logSnapshot };
  console.log('[harness] SONNET5 RESULT | ' + JSON.stringify(r.text.slice(0, 200)));
}
