// STAGE: plain text chat — proves real Bedrock inference returns a response.

import { snapshotBedrockChatLog } from '../lib/verify.mjs';

export async function run(ctx) {
  const { ui, userDataDir } = ctx;
  console.log('[harness] STAGE 04: text chat');

  const logSnapshot = snapshotBedrockChatLog(userDataDir);
  await ui.typePrompt('Reply with exactly this token and nothing else: BEDROCK_E2E_OK');
  await ui.shot('prompt-typed');
  const r = await ui.waitResponse({ maxMs: 30000 });
  await ui.shot('text-response');
  ctx.results.text = { ...r, logSnapshot };
  console.log('[harness] TEXT RESULT | ' + JSON.stringify(r.text.slice(0, 200)));
}
